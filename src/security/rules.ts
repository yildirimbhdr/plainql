import type { Operation, PlainQLConfig, RoleRule, TableRule } from '../config/types.js'
import { SecurityError } from './violations.js'

const ALL_OPERATIONS: Operation[] = ['SELECT', 'INSERT', 'UPDATE', 'DELETE']

/**
 * A table's rules after the base config and the active role have been merged.
 *
 * Every field is resolved: no undefined-means-something indirection is left for
 * the validator to interpret. `allowed` already accounts for allow, deny and the
 * role's globalAllow, so a layer only has to ask whether an operation is in it.
 */
export interface EffectiveTableRule {
  table: string
  /** Operations that survive every rule. Empty means the table is off limits. */
  allowed: Operation[]
  hidden: string[]
  readonly: string[]
  /** undefined means every column is writable; a list means only those are. */
  writable?: string[]
  masked: Record<string, 'last4' | 'partial'>
  maxRows?: number
  requireWhere: Operation[]
  deletePolicy?: { requireCondition: string }
}

/**
 * Resolves config tables and role rules into one effective rule per table.
 *
 * Roles narrow, never widen: an operation must be permitted by the table rule,
 * by every role in the `extends` chain that mentions the table, and by the
 * role's globalAllow. Restrictions (hidden, readonly, requireWhere) accumulate
 * instead — a role may add them but can never lift one the base config set.
 */
export class RuleSet {
  private config: PlainQLConfig
  private role?: RoleRule
  private cache = new Map<string, EffectiveTableRule>()

  constructor(config: PlainQLConfig, roleName?: string) {
    this.config = config
    this.role = roleName ? this.resolveRole(roleName) : undefined
  }

  /** The effective rule for a table, computed once and memoised. */
  public forTable(table: string): EffectiveTableRule {
    const key = table.toLowerCase()
    const cached = this.cache.get(key)
    if (cached) return cached

    const computed = this.compute(table)
    this.cache.set(key, computed)
    return computed
  }

  /** True when the config names this table explicitly, at base or role level. */
  public isKnownTable(table: string): boolean {
    return this.lookup(this.config.tables, table) !== undefined ||
      this.lookup(this.role?.tables, table) !== undefined
  }

  /** Every table with a hidden or masked column — used to clean up results. */
  public tablesWithColumnRules(): string[] {
    const names = new Set<string>()
    for (const name of Object.keys(this.config.tables ?? {})) names.add(name)
    for (const name of Object.keys(this.role?.tables ?? {})) names.add(name)
    return [...names].filter((name) => {
      const rule = this.forTable(name)
      return rule.hidden.length > 0 || Object.keys(rule.masked).length > 0
    })
  }

  // #region Role resolution

  /**
   * Flattens a role and its `extends` chain into a single RoleRule.
   *
   * The chain is applied base-first, so a role always narrows what it inherits.
   *
   * @throws {SecurityError} when a role is missing or the chain is circular —
   * both would otherwise fail open, applying no restrictions at all.
   */
  private resolveRole(roleName: string): RoleRule {
    const chain: RoleRule[] = []
    const seen = new Set<string>()

    let current: string | undefined = roleName
    while (current) {
      if (seen.has(current)) {
        throw new SecurityError(
          `PlainQL: circular role inheritance detected at "${current}"`
        )
      }
      seen.add(current)

      const rule: RoleRule | undefined = this.config.roles?.[current]
      if (!rule) {
        throw new SecurityError(`PlainQL: unknown role "${current}"`)
      }

      chain.unshift(rule)
      current = rule.extends
    }

    return chain.reduce<RoleRule>((merged, rule) => this.narrowRole(merged, rule), {})
  }

  /** Applies a child role on top of what it inherits, narrowing only. */
  private narrowRole(base: RoleRule, child: RoleRule): RoleRule {
    const tables: Record<string, TableRule> = { ...base.tables }
    for (const [name, rule] of Object.entries(child.tables ?? {})) {
      const existing = this.lookup(tables, name)
      tables[name] = existing ? this.narrowTable(existing, rule) : rule
    }

    return {
      globalAllow: this.intersectOperations(base.globalAllow, child.globalAllow),
      tables
    }
  }

  // #endregion

  // #region Table merging

  private compute(table: string): EffectiveTableRule {
    const base = this.lookup(this.config.tables, table)
    const roleRule = this.lookup(this.role?.tables, table)

    const merged = base && roleRule
      ? this.narrowTable(base, roleRule)
      : (roleRule ?? base ?? {})

    return {
      table,
      allowed: this.resolveAllowed(merged),
      hidden: this.unique(merged.columns?.hidden),
      readonly: this.unique(merged.columns?.readonly),
      writable: merged.columns?.writable ? this.unique(merged.columns.writable) : undefined,
      masked: merged.columns?.masked ?? {},
      maxRows: merged.maxRows,
      requireWhere: this.unique(merged.requireWhere) as Operation[],
      deletePolicy: merged.deletePolicy
    }
  }

  /**
   * Combines two table rules so the result is never more permissive than either.
   *
   * Permissions (allow, writable) intersect; restrictions (deny, hidden,
   * readonly, requireWhere) accumulate; maxRows takes the tighter limit.
   */
  private narrowTable(base: TableRule, child: TableRule): TableRule {
    return {
      allow: this.intersectOperations(base.allow, child.allow),
      deny: this.unique([...(base.deny ?? []), ...(child.deny ?? [])]) as Operation[],
      columns: {
        hidden: this.unique([...(base.columns?.hidden ?? []), ...(child.columns?.hidden ?? [])]),
        readonly: this.unique([
          ...(base.columns?.readonly ?? []),
          ...(child.columns?.readonly ?? [])
        ]),
        // undefined means "all columns"; only intersect when both constrain.
        writable: this.intersectStrings(base.columns?.writable, child.columns?.writable),
        masked: { ...base.columns?.masked, ...child.columns?.masked }
      },
      maxRows: this.tighterLimit(base.maxRows, child.maxRows),
      requireWhere: this.unique([
        ...(base.requireWhere ?? []),
        ...(child.requireWhere ?? [])
      ]) as Operation[],
      deletePolicy: child.deletePolicy ?? base.deletePolicy
    }
  }

  /**
   * Works out which operations survive allow, deny and the role's globalAllow.
   *
   * An absent `allow` means every operation is on the table by default; `deny`
   * always wins over `allow`; globalAllow caps the whole role.
   */
  private resolveAllowed(rule: TableRule): Operation[] {
    let allowed = rule.allow ? this.unique(rule.allow) as Operation[] : [...ALL_OPERATIONS]

    const denied = new Set(rule.deny ?? [])
    allowed = allowed.filter((operation) => !denied.has(operation))

    const globalAllow = this.role?.globalAllow
    if (globalAllow) {
      const permitted = new Set(globalAllow)
      allowed = allowed.filter((operation) => permitted.has(operation))
    }

    return allowed
  }

  // #endregion

  // #region Helpers

  /** Table names are matched case-insensitively, as SQL treats them. */
  private lookup(
    source: Record<string, TableRule> | undefined,
    table: string
  ): TableRule | undefined {
    if (!source) return undefined
    const direct = source[table]
    if (direct) return direct

    const wanted = table.toLowerCase()
    for (const [name, rule] of Object.entries(source)) {
      if (name.toLowerCase() === wanted) return rule
    }
    return undefined
  }

  /** undefined means unconstrained, so it yields to whichever side sets a list. */
  private intersectOperations(
    base: Operation[] | undefined,
    child: Operation[] | undefined
  ): Operation[] | undefined {
    if (!base) return child ? this.unique(child) as Operation[] : undefined
    if (!child) return this.unique(base) as Operation[]
    const permitted = new Set(child)
    return this.unique(base.filter((operation) => permitted.has(operation))) as Operation[]
  }

  private intersectStrings(
    base: string[] | undefined,
    child: string[] | undefined
  ): string[] | undefined {
    if (!base) return child ? this.unique(child) : undefined
    if (!child) return this.unique(base)
    const permitted = new Set(child)
    return this.unique(base.filter((value) => permitted.has(value)))
  }

  private tighterLimit(base?: number, child?: number): number | undefined {
    if (base === undefined) return child
    if (child === undefined) return base
    return Math.min(base, child)
  }

  private unique<T>(values: T[] | undefined): T[] {
    return values ? [...new Set(values)] : []
  }

  // #endregion
}
