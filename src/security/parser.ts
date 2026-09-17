import pkg from 'node-sql-parser'
import type { Operation } from '../config/types.js'
import { Dialect } from '../schema/types.js'
import { SecurityError } from './violations.js'

const { Parser } = pkg

/**
 * A column reference found in a statement, already resolved to its real table.
 *
 * `table` is undefined when the reference is ambiguous — an unqualified column
 * in a multi-table statement. Callers must treat that as "could be any table"
 * and check it against all of them; in security, unknown means unsafe.
 */
export interface ColumnRef {
  table?: string
  column: string
}

/** Everything the validator layers need to know about a statement. */
export interface ParsedStatement {
  operation: Operation
  /** Every table touched, including joins and subqueries. Deduplicated. */
  tables: string[]
  /** Columns read: SELECT list, WHERE, JOIN conditions. */
  readColumns: ColumnRef[]
  /** Columns written: UPDATE ... SET targets and INSERT column lists. */
  writeColumns: ColumnRef[]
  hasWhere: boolean
  /** Raw text of the WHERE clause, lowercased. Empty when there is none. */
  whereText: string
  /** The LIMIT value when the statement is a plain numeric-limit SELECT. */
  limit?: number
  /**
   * Names introduced by `AS` in the SELECT list.
   *
   * These look like unqualified columns when they are reused in ORDER BY or
   * HAVING, but they belong to no table — callers skip them instead of testing
   * them against every table's rules.
   */
  outputAliases: string[]
}

/** Maps our Dialect onto the parser's database names. */
const DIALECT_TO_DATABASE: Record<Dialect, string> = {
  [Dialect.PostgreSQL]: 'postgresql',
  [Dialect.MySQL]: 'mysql',
  [Dialect.SQLite]: 'sqlite'
}

const STATEMENT_TYPE_TO_OPERATION: Record<string, Operation> = {
  select: 'SELECT',
  insert: 'INSERT',
  update: 'UPDATE',
  delete: 'DELETE'
}

/**
 * Turns SQL into the flat shape the validator reasons about.
 *
 * This is the only place that knows what a node-sql-parser AST looks like —
 * every layer above works with ParsedStatement instead, so swapping the parser
 * out later touches this file alone.
 */
export class SqlParser {
  private parser = new Parser()
  private database: string

  constructor(dialect: Dialect) {
    this.database = DIALECT_TO_DATABASE[dialect]
  }

  /**
   * @throws {SecurityError} when the SQL cannot be parsed, is empty, chains
   * multiple statements, or uses an operation we do not model.
   */
  public parse(sql: string): ParsedStatement {
    const trimmed = sql.trim()
    if (!trimmed) throw new SecurityError('SecurityValidator: empty SQL statement')

    let ast: unknown
    try {
      ast = this.parser.astify(trimmed, { database: this.database })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new SecurityError(`SecurityValidator: could not parse SQL — ${reason}`)
    }

    // An array means the input held several statements chained with `;`.
    // Layer 1 blocks those too, but refusing here keeps the parser honest for
    // any caller that reaches it directly.
    if (Array.isArray(ast)) {
      if (ast.length !== 1) {
        throw new SecurityError('SecurityValidator: multiple SQL statements are not allowed')
      }
      ast = ast[0]
    }

    const node = this.asRecord(ast)
    if (!node) throw new SecurityError('SecurityValidator: unrecognised SQL structure')

    const type = typeof node['type'] === 'string' ? (node['type'] as string).toLowerCase() : ''
    const operation = STATEMENT_TYPE_TO_OPERATION[type]
    if (!operation) {
      throw new SecurityError(`SecurityValidator: unsupported statement type "${type || 'unknown'}"`)
    }

    const tables: string[] = []
    const aliases = new Map<string, string>()
    this.collectTables(node, tables, aliases)

    const readColumns: ColumnRef[] = []
    const writeColumns: ColumnRef[] = []
    this.collectColumns(node, operation, readColumns, writeColumns)

    const where = node['where']
    const hasWhere = where !== null && where !== undefined

    const soleTable = tables.length === 1 ? tables[0] : undefined
    const resolve = (refs: ColumnRef[]): ColumnRef[] =>
      refs.map((ref) => this.resolveRef(ref, aliases, soleTable))

    return {
      operation,
      tables,
      readColumns: this.dedupeColumns(resolve(readColumns)),
      writeColumns: this.dedupeColumns(resolve(writeColumns)),
      hasWhere,
      whereText: hasWhere ? this.extractWhereText(trimmed) : '',
      limit: this.extractLimit(node),
      outputAliases: this.collectOutputAliases(node)
    }
  }

  // #region Tables

  /**
   * Walks the whole node collecting table names and alias bindings.
   *
   * Recursion matters: a subquery hidden in a WHERE clause reaches tables the
   * top level never names, and those must be subject to the same rules.
   */
  private collectTables(node: unknown, tables: string[], aliases: Map<string, string>): void {
    if (Array.isArray(node)) {
      for (const item of node) this.collectTables(item, tables, aliases)
      return
    }

    const record = this.asRecord(node)
    if (!record) return

    // A column_ref carries `table` too, but it holds an alias, not a table
    // name — recording it would invent tables that do not exist. Its children
    // are still walked below so nothing nested is missed.
    const isColumnRef = record['type'] === 'column_ref'

    // A table entry looks like { db, table, as }. `as` may be null.
    const table = record['table']
    if (!isColumnRef && typeof table === 'string' && table) {
      if (!tables.includes(table)) tables.push(table)
      const alias = record['as']
      if (typeof alias === 'string' && alias) aliases.set(alias, table)
    }

    for (const key of Object.keys(record)) {
      // `table` on a column_ref is a string alias, not a nested node.
      if (key === 'table' && typeof record[key] === 'string') continue
      this.collectTables(record[key], tables, aliases)
    }
  }

  // #endregion

  // #region Columns

  private collectColumns(
    node: Record<string, unknown>,
    operation: Operation,
    read: ColumnRef[],
    write: ColumnRef[]
  ): void {
    if (operation === 'UPDATE') {
      // set: [{ column, value, table }]
      for (const entry of this.asArray(node['set'])) {
        const record = this.asRecord(entry)
        const column = record?.['column']
        if (typeof column === 'string') {
          const table = record?.['table']
          write.push({ table: typeof table === 'string' ? table : undefined, column })
        }
        // The assigned value may itself read columns or hold a subquery.
        this.collectReadRefs(record?.['value'], read)
      }
      this.collectReadRefs(node['where'], read)
      return
    }

    if (operation === 'INSERT') {
      // columns: ['email', 'name'] — plain strings, no table qualifier.
      const target = this.firstTableName(node['table'])
      for (const column of this.asArray(node['columns'])) {
        if (typeof column === 'string') write.push({ table: target, column })
      }
      this.collectReadRefs(node['values'], read)
      return
    }

    // SELECT and DELETE: every column_ref anywhere in the statement is a read.
    this.collectReadRefs(node, read)
  }

  /** Recursively gathers every column_ref node, subqueries included. */
  private collectReadRefs(node: unknown, read: ColumnRef[]): void {
    if (Array.isArray(node)) {
      for (const item of node) this.collectReadRefs(item, read)
      return
    }

    const record = this.asRecord(node)
    if (!record) return

    if (record['type'] === 'column_ref') {
      const column = record['column']
      if (typeof column === 'string') {
        const table = record['table']
        read.push({ table: typeof table === 'string' ? table : undefined, column })
      }
      return
    }

    for (const key of Object.keys(record)) this.collectReadRefs(record[key], read)
  }

  /**
   * Rewrites an alias to the real table name.
   *
   * An unqualified column resolves to the only table in play when there is
   * exactly one; with several tables it stays undefined so the validator knows
   * it cannot pin the reference down.
   */
  private resolveRef(ref: ColumnRef, aliases: Map<string, string>, soleTable?: string): ColumnRef {
    if (!ref.table) return { table: soleTable, column: ref.column }
    return { table: aliases.get(ref.table) ?? ref.table, column: ref.column }
  }

  /** Reads the `AS` names from the SELECT list, lowercased for comparison. */
  private collectOutputAliases(node: Record<string, unknown>): string[] {
    const aliases: string[] = []
    for (const entry of this.asArray(node['columns'])) {
      const alias = this.asRecord(entry)?.['as']
      if (typeof alias === 'string' && alias) aliases.push(alias.toLowerCase())
    }
    return [...new Set(aliases)]
  }

  private dedupeColumns(refs: ColumnRef[]): ColumnRef[] {
    const seen = new Set<string>()
    const unique: ColumnRef[] = []
    for (const ref of refs) {
      const key = `${ref.table ?? ''}.${ref.column}`
      if (seen.has(key)) continue
      seen.add(key)
      unique.push(ref)
    }
    return unique
  }

  // #endregion

  // #region Helpers

  private firstTableName(node: unknown): string | undefined {
    for (const entry of this.asArray(node)) {
      const table = this.asRecord(entry)?.['table']
      if (typeof table === 'string' && table) return table
    }
    return undefined
  }

  /**
   * Reads the LIMIT value when it is a plain number.
   *
   * Shape: { seperator, value: [{ type: 'number', value: 10 }] }. With OFFSET
   * the array holds two entries; we take the last, which is the row count.
   * Anything non-numeric (a placeholder, an expression) returns undefined so
   * the caller injects its own limit rather than trusting what it cannot read.
   */
  private extractLimit(node: Record<string, unknown>): number | undefined {
    const limit = this.asRecord(node['limit'])
    if (!limit) return undefined

    const entries = this.asArray(limit['value'])
    const last = this.asRecord(entries[entries.length - 1])
    const value = last?.['value']
    return typeof value === 'number' ? value : undefined
  }

  /**
   * Pulls the WHERE clause text straight out of the original SQL.
   *
   * deletePolicy.requireCondition is configured as a text fragment, so it is
   * matched against text. Lowercased for case-insensitive comparison.
   */
  private extractWhereText(sql: string): string {
    const match = /\bwhere\b([\s\S]*)$/i.exec(sql)
    if (!match?.[1]) return ''
    return match[1]
      .replace(/\b(group\s+by|order\s+by|having|limit|returning)\b[\s\S]*$/i, '')
      .trim()
      .toLowerCase()
  }

  private asRecord(value: unknown): Record<string, unknown> | undefined {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
    return value as Record<string, unknown>
  }

  private asArray(value: unknown): unknown[] {
    return Array.isArray(value) ? value : []
  }

  // #endregion
}
