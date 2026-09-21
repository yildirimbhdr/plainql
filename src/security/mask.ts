import type { RuleSet } from './rules.js'

type MaskKind = 'last4' | 'partial'

// Second line of defence after layer 2: a view, an unresolved wildcard or a
// relaxed onViolation must still never leak a hidden column.
export class ResultMasker {
  private rules: RuleSet

  constructor(rules: RuleSet) {
    this.rules = rules
  }

  public apply(rows: unknown[], tables: string[]): unknown[] {
    const hidden = new Set<string>()
    const masked = new Map<string, MaskKind>()

    for (const table of tables) {
      const rule = this.rules.forTable(table)
      for (const column of rule.hidden) hidden.add(column.toLowerCase())
      for (const [column, kind] of Object.entries(rule.masked)) {
        masked.set(column.toLowerCase(), kind)
      }
    }

    if (hidden.size === 0 && masked.size === 0) return rows
    return rows.map((row) => this.cleanRow(row, hidden, masked))
  }

  private cleanRow(
    row: unknown,
    hidden: Set<string>,
    masked: Map<string, MaskKind>
  ): unknown {
    if (typeof row !== 'object' || row === null || Array.isArray(row)) return row

    const cleaned: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(row as Record<string, unknown>)) {
      const name = key.toLowerCase()
      if (hidden.has(name)) continue

      const kind = masked.get(name)
      cleaned[key] = kind ? this.maskValue(value, kind) : value
    }
    return cleaned
  }

  private maskValue(value: unknown, kind: MaskKind): unknown {
    if (value === null || value === undefined) return value
    const text = String(value)
    return kind === 'last4' ? this.maskLast4(text) : this.maskPartial(text)
  }

  private maskLast4(value: string): string {
    if (value.length <= 4) return '*'.repeat(value.length)
    return '*'.repeat(value.length - 4) + value.slice(-4)
  }

  // john@example.com → jo***@example.com; the domain is what keeps a row recognisable.
  private maskPartial(value: string): string {
    const at = value.indexOf('@')
    if (at > 0) {
      const local = value.slice(0, at)
      const domain = value.slice(at)
      return `${this.maskPartial(local)}${domain}`
    }

    // A fixed two-character head keeps the value recognisable without hinting at its length.
    if (value.length <= 2) return '*'.repeat(value.length)
    return value.slice(0, 2) + '***'
  }
}
