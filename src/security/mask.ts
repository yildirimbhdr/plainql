import type { RuleSet } from './rules.js'

type MaskKind = 'last4' | 'partial'

/**
 * Cleans query results before they leave the library.
 *
 * Hidden columns are already refused by layer 2, so stripping them here is a
 * second line of defence: a view, a wildcard the parser could not resolve, or a
 * relaxed `onViolation` setting must still never leak one. Masked columns are
 * rewritten rather than removed — the caller gets a usable, redacted value.
 */
export class ResultMasker {
  private rules: RuleSet

  constructor(rules: RuleSet) {
    this.rules = rules
  }

  /**
   * Applies the column rules of every table the query touched.
   *
   * Result keys carry no table qualifier, so the rules of all tables involved
   * are merged: if any of them hides a column, it is stripped.
   */
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

  /** Null and undefined stay as they are — there is nothing to reveal. */
  private maskValue(value: unknown, kind: MaskKind): unknown {
    if (value === null || value === undefined) return value
    const text = String(value)
    return kind === 'last4' ? this.maskLast4(text) : this.maskPartial(text)
  }

  /** Keeps the final four characters: 4242424242424242 → ************4242 */
  private maskLast4(value: string): string {
    if (value.length <= 4) return '*'.repeat(value.length)
    return '*'.repeat(value.length - 4) + value.slice(-4)
  }

  /**
   * Keeps the shape of the value while hiding its middle.
   *
   * An email keeps its domain, since that is usually what makes the row
   * recognisable without exposing the account: john@example.com → jo***@example.com
   */
  private maskPartial(value: string): string {
    const at = value.indexOf('@')
    if (at > 0) {
      const local = value.slice(0, at)
      const domain = value.slice(at)
      return `${this.maskPartial(local)}${domain}`
    }

    // Two characters are never enough to identify anyone, so they are dropped
    // entirely; beyond that a fixed two-character head keeps the value
    // recognisable without hinting at its length.
    if (value.length <= 2) return '*'.repeat(value.length)
    return value.slice(0, 2) + '***'
  }
}
