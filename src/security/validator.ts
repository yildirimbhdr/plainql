import type { Operation, PlainQLConfig } from '../config/types.js'
import type { Dialect } from '../schema/types.js'
import { SqlParser, type ColumnRef, type ParsedStatement } from './parser.js'
import { RuleSet, type EffectiveTableRule } from './rules.js'
import { SecurityError, ViolationError, type ViolationLayer } from './violations.js'

// No config or role may ever permit these.
const ALWAYS_BLOCKED = ['DROP', 'TRUNCATE', 'ALTER', 'GRANT', 'REVOKE', 'ATTACH']

export interface ValidationResult {
  sql: string
  operation: Operation
  tables: string[]
  warnings: string[]
  /** Under `onViolation: 'warn'`: the violations that would otherwise have thrown. Non-empty means do not execute. */
  violations: string[]
}

export class SecurityValidator {
  private config: PlainQLConfig
  private parser: SqlParser
  private rules: RuleSet
  private blocked: string[]
  private softViolations: string[] = []

  constructor(config: PlainQLConfig, dialect: Dialect, role?: string) {
    this.config = config
    this.parser = new SqlParser(dialect)
    this.rules = new RuleSet(config, role)
    this.blocked = [
      ...ALWAYS_BLOCKED,
      ...(config.security?.blockedOperations ?? []).map((word) => word.toUpperCase())
    ]
  }

  public get ruleSet(): RuleSet {
    return this.rules
  }

  public validate(sql: string): ValidationResult {
    const warnings: string[] = []
    this.softViolations = []

    // Layer 1 runs on raw text so unparseable SQL is still stopped.
    this.checkBlocklist(sql, warnings)

    const parsed = this.parser.parse(sql)

    this.checkTablesAndColumns(parsed, warnings)
    this.checkRolePermissions(parsed, warnings)
    const sqlToRun = this.checkStatementShape(parsed, sql, warnings)

    return {
      sql: sqlToRun,
      operation: parsed.operation,
      tables: parsed.tables,
      warnings,
      violations: [...this.softViolations]
    }
  }

  private checkBlocklist(sql: string, warnings: string[]): void {
    const stripped = this.stripLiterals(sql)

    for (const keyword of this.blocked) {
      const pattern = new RegExp(`\\b${this.escapeRegex(keyword)}\\b`, 'i')
      if (pattern.test(stripped)) {
        this.report(
          {
            message: `SecurityValidator: "${keyword}" is blocked and cannot be enabled by config or role`,
            layer: 1,
            operation: 'SELECT'
          },
          warnings,
          // Never softened by onViolation: these destroy schema.
          true
        )
      }
    }

    // Anything after a `;` is a second statement. A trailing one is fine.
    if (stripped.replace(/;\s*$/, '').includes(';')) {
      this.report(
        {
          message: 'SecurityValidator: multiple SQL statements are not allowed',
          layer: 1,
          operation: 'SELECT'
        },
        warnings,
        true
      )
    }
  }

  private checkTablesAndColumns(parsed: ParsedStatement, warnings: string[]): void {
    for (const table of parsed.tables) {
      const rule = this.rules.forTable(table)
      if (!rule.allowed.includes(parsed.operation)) {
        // Layer 3 explains role-driven refusals; this one is the table's own.
        if (!this.isRoleDriven(table, parsed.operation)) {
          this.report(
            {
              message: `SecurityValidator: ${parsed.operation} is not allowed on table "${table}"`,
              layer: 2,
              operation: parsed.operation,
              table
            },
            warnings
          )
        }
      }
    }

    this.checkHiddenColumns(parsed, warnings)
    this.checkWriteColumns(parsed, warnings)
  }

  // `SELECT *` on a table with hidden columns is refused too: a wildcard would pull them out.
  private checkHiddenColumns(parsed: ParsedStatement, warnings: string[]): void {
    for (const ref of parsed.readColumns) {
      for (const table of this.candidateTables(ref, parsed)) {
        const rule = this.rules.forTable(table)
        if (rule.hidden.length === 0) continue

        if (ref.column === '*') {
          this.report(
            {
              message: `SecurityValidator: SELECT * is not allowed on "${table}" because it has hidden columns (${rule.hidden.join(', ')})`,
              layer: 2,
              operation: parsed.operation,
              table
            },
            warnings
          )
          continue
        }

        if (this.containsColumn(rule.hidden, ref.column)) {
          this.report(
            {
              message: `SecurityValidator: column "${ref.column}" on table "${table}" is hidden and cannot be selected`,
              layer: 2,
              operation: parsed.operation,
              table,
              column: ref.column
            },
            warnings
          )
        }
      }
    }
  }

  private checkWriteColumns(parsed: ParsedStatement, warnings: string[]): void {
    for (const ref of parsed.writeColumns) {
      for (const table of this.candidateTables(ref, parsed)) {
        const rule = this.rules.forTable(table)

        // Hidden columns are invisible, so they cannot be written either.
        if (this.containsColumn(rule.hidden, ref.column)) {
          this.report(
            {
              message: `SecurityValidator: column "${ref.column}" on table "${table}" is hidden and cannot be written`,
              layer: 2,
              operation: parsed.operation,
              table,
              column: ref.column
            },
            warnings
          )
        }

        if (this.containsColumn(rule.readonly, ref.column)) {
          this.report(
            {
              message: `SecurityValidator: column "${ref.column}" on table "${table}" is read-only`,
              layer: 2,
              operation: parsed.operation,
              table,
              column: ref.column
            },
            warnings
          )
        }

        if (rule.writable && !this.containsColumn(rule.writable, ref.column)) {
          this.report(
            {
              message: `SecurityValidator: column "${ref.column}" on table "${table}" is not writable (allowed: ${rule.writable.join(', ')})`,
              layer: 2,
              operation: parsed.operation,
              table,
              column: ref.column
            },
            warnings
          )
        }
      }
    }
  }

  // RuleSet already folded the role into `allowed`; this layer exists so the
  // error names the role, not the table.
  private checkRolePermissions(parsed: ParsedStatement, warnings: string[]): void {
    for (const table of parsed.tables) {
      if (!this.isRoleDriven(table, parsed.operation)) continue

      const rule = this.rules.forTable(table)
      if (!rule.allowed.includes(parsed.operation)) {
        this.report(
          {
            message: `SecurityValidator: role does not permit ${parsed.operation} on table "${table}"`,
            layer: 3,
            operation: parsed.operation,
            table
          },
          warnings
        )
      }
    }
  }

  /** True when the role, not the table rule, is what removes the operation. */
  private isRoleDriven(table: string, operation: Operation): boolean {
    const withRole = this.rules.forTable(table)
    if (withRole.allowed.includes(operation)) return false

    const withoutRole = new RuleSet(this.config).forTable(table)
    return withoutRole.allowed.includes(operation)
  }

  private checkStatementShape(
    parsed: ParsedStatement,
    sql: string,
    warnings: string[]
  ): string {
    const needsWhereGlobally =
      this.config.security?.requireWhereClause === true &&
      (parsed.operation === 'UPDATE' || parsed.operation === 'DELETE')

    for (const table of parsed.tables) {
      const rule = this.rules.forTable(table)
      const needsWhere = needsWhereGlobally || rule.requireWhere.includes(parsed.operation)

      if (needsWhere && !parsed.hasWhere) {
        this.report(
          {
            message: `SecurityValidator: ${parsed.operation} on "${table}" requires a WHERE clause`,
            layer: 4,
            operation: parsed.operation,
            table
          },
          warnings
        )
      }

      if (parsed.operation === 'DELETE' && rule.deletePolicy) {
        const required = rule.deletePolicy.requireCondition.toLowerCase()
        if (!parsed.whereText.includes(required)) {
          this.report(
            {
              message: `SecurityValidator: DELETE on "${table}" requires condition "${rule.deletePolicy.requireCondition}" in its WHERE clause`,
              layer: 4,
              operation: parsed.operation,
              table
            },
            warnings
          )
        }
      }
    }

    return this.applyMaxRows(parsed, sql, warnings)
  }

  // Tightest maxRows across the statement's tables wins; an unreadable LIMIT is replaced, not trusted.
  private applyMaxRows(parsed: ParsedStatement, sql: string, warnings: string[]): string {
    if (parsed.operation !== 'SELECT') return sql

    let cap: number | undefined
    for (const table of parsed.tables) {
      const maxRows = this.rules.forTable(table).maxRows
      if (maxRows === undefined) continue
      cap = cap === undefined ? maxRows : Math.min(cap, maxRows)
    }
    if (cap === undefined) return sql

    if (parsed.limit !== undefined && parsed.limit <= cap) return sql

    const trimmed = sql.trim().replace(/;\s*$/, '')
    if (parsed.limit === undefined) {
      warnings.push(`SecurityValidator: applied LIMIT ${cap}`)
      return `${trimmed} LIMIT ${cap}`
    }

    warnings.push(`SecurityValidator: reduced LIMIT from ${parsed.limit} to ${cap}`)
    return trimmed.replace(/\blimit\s+\d+(\s*,\s*\d+)?\s*$/i, `LIMIT ${cap}`)
  }

  // An unqualified column could belong to any table in the statement, so it is
  // checked against all of them — unknown means unsafe.
  private candidateTables(ref: ColumnRef, parsed: ParsedStatement): string[] {
    if (ref.table) return [ref.table]
    if (parsed.outputAliases.includes(ref.column.toLowerCase())) return []
    return parsed.tables
  }

  private containsColumn(list: string[], column: string): boolean {
    const wanted = column.toLowerCase()
    return list.some((entry) => entry.toLowerCase() === wanted)
  }

  private stripLiterals(sql: string): string {
    return sql
      .replace(/'(?:[^']|'')*'/g, "''")
      .replace(/"(?:[^"]|"")*"/g, '""')
      .replace(/--[^\n]*/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
  }

  private escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }

  private report(
    details: {
      message: string
      layer: ViolationLayer
      operation: Operation
      table?: string
      column?: string
    },
    warnings: string[],
    alwaysThrow = false
  ): void {
    const mode = this.config.security?.onViolation ?? 'throw'
    if (alwaysThrow || mode === 'throw') throw new ViolationError(details)
    if (mode === 'warn') {
      console.warn(details.message)
      warnings.push(details.message)
      this.softViolations.push(details.message)
    }
  }
}

export { SecurityError, ViolationError }
export type { EffectiveTableRule, ParsedStatement }
