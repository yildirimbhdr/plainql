import type { RuleSet } from '../security/rules.js'
import type { ColumnInfo, RelationInfo, SchemaContext, TableInfo } from '../schema/types.js'

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'of', 'in', 'on', 'at', 'to', 'for', 'from', 'by', 'with', 'and', 'or',
  'is', 'are', 'was', 'were', 'be', 'been', 'do', 'does', 'did', 'has', 'have', 'had',
  'get', 'give', 'show', 'list', 'find', 'fetch', 'return', 'select', 'me', 'all', 'any',
  'how', 'many', 'much', 'what', 'which', 'who', 'that', 'this', 'these', 'those', 'it',
  'last', 'first', 'top', 'recent', 'latest', 'newest', 'oldest', 'count', 'number', 'total',
  'today', 'yesterday', 'week', 'month', 'year', 'day', 'days', 'ago', 'than', 'more', 'less',
  'not', 'no', 'only', 'per', 'each', 'every', 'their', 'its', 'my', 'our', 'your'
])

export interface PromptOptions {
  maxSchemaTokens?: number
  maxTables?: number
}

export type PromptMode = 'full' | 'selected'

export interface BuiltPrompt {
  /** Byte-identical across calls for the same role and schema, so the provider caches it. */
  system: string
  user: string
  tables: string[]
  mode: PromptMode
}

const DEFAULT_MAX_SCHEMA_TOKENS = 32_000
const DEFAULT_MAX_TABLES = 20
const MAX_COLUMN_SCORE = 4
// Measured 2.3 chars/token on a real 122-table schema; identifiers tokenise worse than prose.
const CHARS_PER_TOKEN = 2.3

export class PromptBuilder {
  private rules: RuleSet
  private maxSchemaTokens: number
  private maxTables: number

  constructor(rules: RuleSet, options: PromptOptions = {}) {
    this.rules = rules
    this.maxSchemaTokens = options.maxSchemaTokens ?? DEFAULT_MAX_SCHEMA_TOKENS
    this.maxTables = options.maxTables ?? DEFAULT_MAX_TABLES
  }

  public build(intent: string, context: SchemaContext, pin: string[] = []): BuiltPrompt {
    const trimmed = intent.trim()
    if (!trimmed) {
      throw new Error('PlainQL: intent must not be empty')
    }

    const visible = this.filterSchema(context)
    const whole = this.serialiseSchema(visible, visible.tables)
    if (this.estimateTokens(whole) <= this.maxSchemaTokens) {
      return {
        system: this.systemPrompt(context.dialect, 'full', whole),
        user: `Request: ${trimmed}`,
        tables: visible.tables.map((table) => table.name),
        mode: 'full'
      }
    }

    const wanted = new Set(pin.map((name) => name.toLowerCase()))
    const pinned = visible.tables.filter((table) => wanted.has(table.name.toLowerCase()))
    const selected = this.selectTables(trimmed, visible)

    const detailed = [...pinned]
    const detailedNames = new Set(pinned.map((table) => table.name))
    for (const table of selected) {
      if (detailedNames.has(table.name)) continue
      detailed.push(table)
      detailedNames.add(table.name)
    }
    const others = visible.tables.filter((table) => !detailedNames.has(table.name))

    return {
      system: this.systemPrompt(context.dialect, 'selected'),
      user: this.userPrompt(trimmed, visible, detailed, others),
      tables: detailed.map((table) => table.name),
      mode: 'selected'
    }
  }

  public estimateTokens(text: string): number {
    return Math.ceil(text.length / CHARS_PER_TOKEN)
  }

  public filterSchema(context: SchemaContext): SchemaContext {
    const tables: TableInfo[] = []
    for (const table of context.tables) {
      const rule = this.rules.forTable(table.name)
      if (rule.allowed.length === 0) continue

      const hidden = new Set(rule.hidden.map((column) => column.toLowerCase()))
      const columns = table.columns.filter((column) => !hidden.has(column.name.toLowerCase()))
      const kept = new Set(columns.map((column) => column.name.toLowerCase()))
      const indexes = table.indexes.filter((index) =>
        index.columns.every((column) => kept.has(column.toLowerCase()))
      )
      tables.push({ ...table, columns, indexes })
    }

    const columnsOf = new Map(
      tables.map((table) => [
        table.name.toLowerCase(),
        new Set(table.columns.map((column) => column.name.toLowerCase()))
      ])
    )
    const relations = context.relations.filter((relation) =>
      columnsOf.get(relation.fromTable.toLowerCase())?.has(relation.fromColumn.toLowerCase()) &&
      columnsOf.get(relation.toTable.toLowerCase())?.has(relation.toColumn.toLowerCase())
    )

    return { dialect: context.dialect, tables, relations }
  }

  // Scored by intent words in table names (strong) and column-name parts (weak),
  // then FK neighbours fill the remaining slots. No match at all → names only,
  // and the model asks for what it needs rather than us guessing twenty tables.
  public selectTables(intent: string, context: SchemaContext): TableInfo[] {
    if (context.tables.length <= this.maxTables) return context.tables

    const terms = this.intentTerms(intent)
    const scored = context.tables
      .map((table) => ({ table, score: this.score(table, terms) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)

    if (scored.length === 0) return []

    const selected: TableInfo[] = []
    const chosen = new Set<string>()
    for (const { table } of scored) {
      if (selected.length >= this.maxTables) break
      selected.push(table)
      chosen.add(table.name.toLowerCase())
    }

    const byName = new Map(context.tables.map((table) => [table.name.toLowerCase(), table]))
    for (const neighbour of this.rankedNeighbours(chosen, context.relations)) {
      if (selected.length >= this.maxTables) break
      const table = byName.get(neighbour)
      if (!table) continue
      selected.push(table)
      chosen.add(neighbour)
    }

    return selected
  }

  private rankedNeighbours(chosen: Set<string>, relations: RelationInfo[]): string[] {
    const links = new Map<string, number>()
    for (const relation of relations) {
      const from = relation.fromTable.toLowerCase()
      const to = relation.toTable.toLowerCase()
      const neighbour = chosen.has(from) && !chosen.has(to) ? to
        : chosen.has(to) && !chosen.has(from) ? from
        : undefined
      if (neighbour) links.set(neighbour, (links.get(neighbour) ?? 0) + 1)
    }
    return [...links.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([name]) => name)
  }

  private intentTerms(intent: string): Set<string> {
    const terms = new Set<string>()
    for (const raw of intent.toLowerCase().split(/[^a-z0-9]+/)) {
      if (raw.length < 2 || STOP_WORDS.has(raw)) continue
      terms.add(raw)
      terms.add(this.singular(raw))
    }
    return terms
  }

  private score(table: TableInfo, terms: Set<string>): number {
    const name = table.name.toLowerCase()
    let score = 0

    if (terms.has(name) || terms.has(this.singular(name))) score += 5
    for (const part of name.split(/[_\s]+/)) {
      if (part && (terms.has(part) || terms.has(this.singular(part)))) score += 3
    }
    // Capped so wide tables cannot outrank a table the intent names outright.
    let fromColumns = 0
    for (const column of table.columns) {
      for (const part of column.name.toLowerCase().split('_')) {
        if (part.length < 3 || part === 'id') continue
        if (terms.has(part) || terms.has(this.singular(part))) fromColumns += 1
      }
    }
    return score + Math.min(fromColumns, MAX_COLUMN_SCORE)
  }

  private singular(word: string): string {
    if (word.endsWith('ies') && word.length > 4) return `${word.slice(0, -3)}y`
    if (word.endsWith('ses') || word.endsWith('xes') || word.endsWith('shes') || word.endsWith('ches')) {
      return word.slice(0, -2)
    }
    if (word.endsWith('s') && !word.endsWith('ss') && word.length > 3) return word.slice(0, -1)
    return word
  }

  private systemPrompt(dialect: string, mode: PromptMode, schema?: string): string {
    const lines = [
      `You translate natural-language requests into a single ${dialect} SQL statement.`,
      '',
      'Rules:',
      '- Use only the tables and columns listed in the schema. Never invent names.',
      '- Return exactly one statement. No multiple statements, no comments.',
      '- Never write SELECT *. List the columns you return explicitly; the schema shows every one available.',
      '- Use the relations shown as "-> table.column" to join tables.',
      '- Column types are shown as the database reports them; nullable columns end with "?".',
      '- Lines starting with "note:" explain how a table or one of its columns is really used',
      '  (allowed values, JSON layout, units). They override whatever the names suggest.'
    ]
    if (mode === 'selected') {
      lines.push(
        '- Tables under "Other tables" are listed by name only. Never guess their columns.',
        '  If you need any of them, respond with {"sql": "", "needTables": ["name", ...]} and their',
        '  columns will be provided. Ask for every table you need in one go.'
      )
    }
    lines.push(
      '- If the request cannot be answered with the schema, still return your best single statement.',
      '',
      'Respond with only a JSON object of the form {"sql": "...", "needTables": []}.',
      'No prose, no markdown fences, nothing before or after the JSON.'
    )

    const context = this.rules.context?.trim()
    if (context) lines.push('', 'Domain notes:', context)
    if (schema !== undefined) lines.push('', `Schema (${dialect}):`, schema)
    return lines.join('\n')
  }

  private userPrompt(
    intent: string,
    context: SchemaContext,
    detailed: TableInfo[],
    others: TableInfo[]
  ): string {
    const lines: string[] = [`Dialect: ${context.dialect}`]
    if (detailed.length > 0) {
      lines.push('', 'Schema:', this.serialiseSchema(context, detailed))
    }

    if (others.length > 0) {
      lines.push('', 'Other tables (columns omitted):')
      lines.push(others.map((table) => table.name).join(', '))
    }

    lines.push('', `Request: ${intent}`)
    return lines.join('\n')
  }

  private serialiseSchema(context: SchemaContext, tables: TableInfo[]): string {
    const relationsFrom = this.relationIndex(context.relations)
    return tables.flatMap((table) => this.serialiseTable(table, relationsFrom)).join('\n')
  }

  private serialiseTable(
    table: TableInfo,
    relationsFrom: Map<string, RelationInfo>
  ): string[] {
    const columns = table.columns
      .map((column) => this.serialiseColumn(table.name, column, relationsFrom))
      .join(', ')
    const rows = table.rowCount !== undefined ? ` ~${table.rowCount} rows` : ''
    const lines = [`${table.name}(${columns})${rows}`]

    const indexes = table.indexes
      .filter((index) => !(index.columns.length === 1 && this.isPrimary(table, index.columns[0])))
      .map((index) => `${index.isUnique ? 'unique' : 'idx'}(${index.columns.join(',')})`)
    if (indexes.length > 0) lines.push(`  ${indexes.join(' ')}`)

    lines.push(...this.serialiseNotes(table))
    return lines
  }

  // A hint for a column not in the filtered table is dropped: hidden columns
  // stay unmentioned and a config typo cannot teach the model a bad name.
  private serialiseNotes(table: TableInfo): string[] {
    const rule = this.rules.forTable(table.name)
    const lines: string[] = []
    if (rule.description?.trim()) lines.push(`  note: ${this.oneLine(rule.description)}`)

    const present = new Map(table.columns.map((column) => [column.name.toLowerCase(), column.name]))
    for (const [column, note] of Object.entries(rule.hints)) {
      const name = present.get(column.toLowerCase())
      if (name) lines.push(`  note ${name}: ${this.oneLine(note)}`)
    }
    return lines
  }

  private oneLine(text: string): string {
    return text.replace(/\s+/g, ' ').trim()
  }

  private serialiseColumn(
    tableName: string,
    column: ColumnInfo,
    relationsFrom: Map<string, RelationInfo>
  ): string {
    let text = `${column.name} ${column.type}`
    if (column.isPrimary) text += ' pk'
    if (column.nullable) text += '?'

    const relation = relationsFrom.get(this.relationKey(tableName, column.name))
    if (relation) text += ` -> ${relation.toTable}.${relation.toColumn}`
    return text
  }

  private relationIndex(relations: RelationInfo[]): Map<string, RelationInfo> {
    const index = new Map<string, RelationInfo>()
    for (const relation of relations) {
      index.set(this.relationKey(relation.fromTable, relation.fromColumn), relation)
    }
    return index
  }

  private relationKey(table: string, column: string): string {
    return `${table.toLowerCase()}.${column.toLowerCase()}`
  }

  private isPrimary(table: TableInfo, columnName: string | undefined): boolean {
    if (!columnName) return false
    const wanted = columnName.toLowerCase()
    return table.columns.some((column) => column.isPrimary && column.name.toLowerCase() === wanted)
  }
}
