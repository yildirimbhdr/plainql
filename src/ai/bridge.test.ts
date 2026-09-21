import { describe, it, expect } from 'vitest'
import { AIBridge, AIError, parseSQLResponse, type AIProvider } from './bridge.js'
import type { BuiltPrompt } from './prompt.js'
import { RuleSet } from '../security/rules.js'
import type { PlainQLConfig } from '../config/types.js'
import { Dialect, type SchemaContext } from '../schema/types.js'

const config: PlainQLConfig = {
  connection: { url: ':memory:' },
  ai: { provider: 'anthropic' }
}

const context: SchemaContext = {
  dialect: Dialect.SQLite,
  tables: [{
    name: 'users',
    columns: [{ name: 'id', type: 'integer', nullable: false, isPrimary: true, isUnique: true, defaultValue: null }],
    indexes: []
  }],
  relations: []
}

describe('parseSQLResponse', () => {
  it('reads a plain JSON object', () => {
    expect(parseSQLResponse('{"sql": "SELECT 1"}')).toEqual({ sql: 'SELECT 1', needTables: [] })
  })

  it('tolerates markdown fences and surrounding whitespace', () => {
    expect(parseSQLResponse('\n```json\n{"sql": "SELECT 1"}\n```\n').sql).toBe('SELECT 1')
    expect(parseSQLResponse('```\n{"sql":"SELECT 2"}```').sql).toBe('SELECT 2')
  })

  it('reads a table request in place of SQL', () => {
    expect(parseSQLResponse('{"sql": "", "needTables": ["order_line", " ", 3, "product"]}'))
      .toEqual({ sql: '', needTables: ['order_line', 'product'] })
  })

  it('rejects prose, missing fields and empty replies with a descriptive error', () => {
    expect(() => parseSQLResponse('Sure! SELECT 1')).toThrow(AIError)
    expect(() => parseSQLResponse('Sure! SELECT 1')).toThrow(/not valid JSON/)
    expect(() => parseSQLResponse('{"query": "SELECT 1"}')).toThrow(/no "sql" field/)
    expect(() => parseSQLResponse('{"sql": 42}')).toThrow(/must be a string/)
    expect(() => parseSQLResponse('{"sql": "   "}')).toThrow(/neither SQL nor a table request/)
    expect(() => parseSQLResponse('{"sql": "", "needTables": []}')).toThrow(/neither SQL nor a table request/)
  })
})

describe('AIBridge', () => {
  it('builds the prompt, calls the provider and reports tokens and tables', async () => {
    const seen: BuiltPrompt[] = []
    const provider: AIProvider = {
      async generate(prompt) {
        seen.push(prompt)
        return { sql: 'SELECT * FROM users', tokens: 321 }
      }
    }

    const bridge = new AIBridge(config.ai, new RuleSet(config), { provider })
    const result = await bridge.generate('all users', context)

    expect(result).toMatchObject({ sql: 'SELECT * FROM users', tokens: 321, tables: ['users'], mode: 'full', rounds: 1 })
    expect(seen).toHaveLength(1)
    expect(seen[0]!.user).toContain('Request: all users')
  })

  it('asks again with the tables the model requested, summing tokens', async () => {
    const wide: SchemaContext = {
      ...context,
      tables: [
        ...Array.from({ length: 5 }, (_, i) => ({ ...context.tables[0]!, name: `t${i}` })),
        { ...context.tables[0]!, name: 'orders' }
      ]
    }
    const seen: BuiltPrompt[] = []
    const provider: AIProvider = {
      async generate(prompt) {
        seen.push(prompt)
        return seen.length === 1
          ? { sql: '', tokens: 100, needTables: ['orders', 'ghost'], usage: { input: 90, output: 10, cacheWrite: 0, cacheRead: 0 } }
          : { sql: 'SELECT * FROM orders', tokens: 250, usage: { input: 200, output: 50, cacheWrite: 0, cacheRead: 0 } }
      }
    }

    const bridge = new AIBridge(config.ai, new RuleSet(config), { provider, maxTables: 2, maxSchemaTokens: 0 })
    const result = await bridge.generate('zzz', wide)

    expect(result).toMatchObject({ sql: 'SELECT * FROM orders', tokens: 350, tables: ['orders'], mode: 'selected', rounds: 2 })
    expect(result.usage).toEqual({ input: 290, output: 60, cacheWrite: 0, cacheRead: 0 })
    expect(seen[0]!.tables).toEqual([])
    expect(seen[1]!.user).toContain('orders(id integer pk)')
  })

  it('gives up when the requested tables do not exist', async () => {
    const provider: AIProvider = {
      async generate() { return { sql: '', tokens: 1, needTables: ['ghost'] } }
    }
    const bridge = new AIBridge(config.ai, new RuleSet(config), { provider, maxSchemaTokens: 0 })
    await expect(bridge.generate('x', context)).rejects.toThrow(/do not exist or are not visible: ghost/)
  })

  it('does not retry in full mode — the model already saw everything', async () => {
    let calls = 0
    const provider: AIProvider = {
      async generate() { calls += 1; return { sql: '', tokens: 1, needTables: ['users'] } }
    }
    const bridge = new AIBridge(config.ai, new RuleSet(config), { provider })
    await expect(bridge.generate('x', context)).rejects.toThrow(/no SQL although the whole schema/)
    expect(calls).toBe(1)
  })

  it('gives up when the model still returns no SQL on the second round', async () => {
    const provider: AIProvider = {
      async generate(prompt) {
        return prompt.tables.length === 0
          ? { sql: '', tokens: 1, needTables: ['users'] }
          : { sql: '', tokens: 1, needTables: ['users'] }
      }
    }
    const wide: SchemaContext = {
      ...context,
      tables: [...Array.from({ length: 5 }, (_, i) => ({ ...context.tables[0]!, name: `t${i}` })), context.tables[0]!]
    }
    const bridge = new AIBridge(config.ai, new RuleSet(config), { provider, maxTables: 2, maxSchemaTokens: 0 })
    await expect(bridge.generate('zzz', wide)).rejects.toThrow(/could not produce SQL even with/)
  })

  it('refuses providers that are not implemented yet', () => {
    expect(() => new AIBridge({ provider: 'openai' }, new RuleSet(config)))
      .toThrow(/"openai" is not implemented yet/)
  })

  it('lets provider errors through untouched', async () => {
    const provider: AIProvider = {
      async generate() { throw new AIError('PlainQL: boom') }
    }
    const bridge = new AIBridge(config.ai, new RuleSet(config), { provider })
    await expect(bridge.generate('x', context)).rejects.toThrow('PlainQL: boom')
  })
})
