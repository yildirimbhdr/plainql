import type { Operation, PlainQLConfig, RoleRule, TableRule } from '../config/types.js'
import { SecurityError } from './violations.js'

const ALL_OPERATIONS: Operation[] = ['SELECT', 'INSERT', 'UPDATE', 'DELETE']

/** A table's rules with the base config and the active role already merged. */
export interface EffectiveTableRule {
  table: string
  /** Operations that survive every rule. Empty means the table is off limits. */
  allowed: Operation[]
  description?: string
  hints: Record<string, string>
  hidden: string[]
  readonly: string[]
  /** undefined means every column is writable; a list means only those are. */
  writable?: string[]
  masked: Record<string, 'last4' | 'partial'>
  maxRows?: number
  requireWhere: Operation[]
  deletePolicy?: { requireCondition: string }
}

// Roles narrow, never widen: permissions intersect, restrictions accumulate.
export class RuleSet {
  private config: PlainQLConfig
  private role?: RoleRule
  private cache = new Map<string, EffectiveTableRule>()

  constructor(config: PlainQLConfig, roleName?: string) {
    this.config = config
    this.role = roleName ? this.resolveRole(roleName) : undefined
  }

  public forTable(table: string): EffectiveTableRule {
    const key = table.toLowerCase()
    const cached = this.cache.get(key)
    if (cached) return cached

    const computed = this.compute(table)
    this.cache.set(key, computed)
    return computed
  }

  public get context(): string | undefined {
    return this.config.context
  }

  public isKnownTable(table: string): boolean {
    return this.lookup(this.config.tables, table) !== undefined ||
      this.lookup(this.role?.tables, table) !== undefined
  }

  public tablesWithColumnRules(): string[] {
    const names = new Set<string>()
    for (const name of Object.keys(this.config.tables ?? {})) names.add(name)
    for (const name of Object.keys(this.role?.tables ?? {})) names.add(name)
    return [...names].filter((name) => {
      const rule = this.forTable(name)
      return rule.hidden.length > 0 || Object.keys(rule.masked).length > 0
    })
  }

  // A missing role or a circular chain throws: both would otherwise fail open.
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

  private compute(table: string): EffectiveTableRule {
    const base = this.lookup(this.config.tables, table)
    const roleRule = this.lookup(this.role?.tables, table)

    const merged = base && roleRule
      ? this.narrowTable(base, roleRule)
      : (roleRule ?? base ?? {})

    return {
      table,
      allowed: this.resolveAllowed(merged),
      description: merged.description,
      hints: this.visibleHints(merged),
      hidden: this.unique(merged.columns?.hidden),
      readonly: this.unique(merged.columns?.readonly),
      writable: merged.columns?.writable ? this.unique(merged.columns.writable) : undefined,
      masked: merged.columns?.masked ?? {},
      maxRows: merged.maxRows,
      requireWhere: this.unique(merged.requireWhere) as Operation[],
      deletePolicy: merged.deletePolicy
    }
  }

  private visibleHints(rule: TableRule): Record<string, string> {
    const hidden = new Set((rule.columns?.hidden ?? []).map((column) => column.toLowerCase()))
    const hints: Record<string, string> = {}
    for (const [column, note] of Object.entries(rule.columns?.hints ?? {})) {
      if (!hidden.has(column.toLowerCase()) && note.trim()) hints[column] = note.trim()
    }
    return hints
  }

  // Notes are not security: the child's description wins and hints merge.
  private narrowTable(base: TableRule, child: TableRule): TableRule {
    return {
      allow: this.intersectOperations(base.allow, child.allow),
      deny: this.unique([...(base.deny ?? []), ...(child.deny ?? [])]) as Operation[],
      description: child.description ?? base.description,
      columns: {
        hints: { ...base.columns?.hints, ...child.columns?.hints },
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
}
