import pkg from 'node-sql-parser'
import type { Operation } from '../config/types.js'
import { Dialect } from '../schema/types.js'
import { SecurityError } from './violations.js'

const { Parser } = pkg

// `table` is undefined for an unqualified column in a multi-table statement:
// callers must check it against every table — unknown means unsafe.
export interface ColumnRef {
  table?: string
  column: string
}

export interface ParsedStatement {
  operation: Operation
  tables: string[]
  readColumns: ColumnRef[]
  writeColumns: ColumnRef[]
  hasWhere: boolean
  /** Lowercased WHERE text; deletePolicy.requireCondition is matched against it. */
  whereText: string
  limit?: number
  /** `AS` names from the SELECT list — they look like columns in ORDER BY but belong to no table. */
  outputAliases: string[]
}

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

// The only place that knows the node-sql-parser AST shape.
export class SqlParser {
  private parser = new Parser()
  private database: string

  constructor(dialect: Dialect) {
    this.database = DIALECT_TO_DATABASE[dialect]
  }

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

    // An array means several statements chained with `;`.
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

  // Recursive: a subquery in a WHERE clause reaches tables the top level never names.
  private collectTables(node: unknown, tables: string[], aliases: Map<string, string>): void {
    if (Array.isArray(node)) {
      for (const item of node) this.collectTables(item, tables, aliases)
      return
    }

    const record = this.asRecord(node)
    if (!record) return

    // A column_ref's `table` is an alias, not a table name — skip it, but still walk its children.
    const isColumnRef = record['type'] === 'column_ref'

    const table = record['table']
    if (!isColumnRef && typeof table === 'string' && table) {
      if (!tables.includes(table)) tables.push(table)
      const alias = record['as']
      if (typeof alias === 'string' && alias) aliases.set(alias, table)
    }

    for (const key of Object.keys(record)) {
      if (key === 'table' && typeof record[key] === 'string') continue
      this.collectTables(record[key], tables, aliases)
    }
  }

  private collectColumns(
    node: Record<string, unknown>,
    operation: Operation,
    read: ColumnRef[],
    write: ColumnRef[]
  ): void {
    if (operation === 'UPDATE') {
      for (const entry of this.asArray(node['set'])) {
        const record = this.asRecord(entry)
        const column = record?.['column']
        if (typeof column === 'string') {
          const table = record?.['table']
          write.push({ table: typeof table === 'string' ? table : undefined, column })
        }
        this.collectReadRefs(record?.['value'], read)
      }
      this.collectReadRefs(node['where'], read)
      return
    }

    if (operation === 'INSERT') {
      const target = this.firstTableName(node['table'])
      for (const column of this.asArray(node['columns'])) {
        if (typeof column === 'string') write.push({ table: target, column })
      }
      this.collectReadRefs(node['values'], read)
      return
    }

    this.collectReadRefs(node, read)
  }

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

  // An unqualified column resolves only when exactly one table is in play.
  private resolveRef(ref: ColumnRef, aliases: Map<string, string>, soleTable?: string): ColumnRef {
    if (!ref.table) return { table: soleTable, column: ref.column }
    return { table: aliases.get(ref.table) ?? ref.table, column: ref.column }
  }

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

  private firstTableName(node: unknown): string | undefined {
    for (const entry of this.asArray(node)) {
      const table = this.asRecord(entry)?.['table']
      if (typeof table === 'string' && table) return table
    }
    return undefined
  }

  // With OFFSET the value array holds two entries; the last is the row count.
  // Non-numeric limits return undefined so the caller injects its own.
  private extractLimit(node: Record<string, unknown>): number | undefined {
    const limit = this.asRecord(node['limit'])
    if (!limit) return undefined

    const entries = this.asArray(limit['value'])
    const last = this.asRecord(entries[entries.length - 1])
    const value = last?.['value']
    return typeof value === 'number' ? value : undefined
  }

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
}
