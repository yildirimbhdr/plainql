import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PlainQL } from './client.js'
import type { AIProvider } from './ai/bridge.js'
import type { BuiltPrompt } from './ai/prompt.js'
import type { PlainQLConfig } from './config/types.js'
import { ViolationError } from './security/violations.js'

/** Answers by matching the request text; records every prompt it saw. */
function fakeProvider(answers: Record<string, string>): AIProvider & { seen: BuiltPrompt[] } {
  const seen: BuiltPrompt[] = []
  return {
    seen,
    async generate(prompt) {
      seen.push(prompt)
      const request = prompt.user.replace(/^Request: /, '')
      const sql = answers[request]
      if (!sql) throw new Error(`fake provider has no answer for "${request}"`)
      return { sql, tokens: 500 }
    }
  }
}

let dir: string
let url: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'plainql-client-'))
  url = join(dir, 'app.db')
  const db = new Database(url)
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT NOT NULL, password_hash TEXT, phone TEXT, active INTEGER DEFAULT 1);
    CREATE TABLE orders (id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users(id), total REAL);
    INSERT INTO users (email, password_hash, phone, active) VALUES
      ('a@x.com', 'h1', '5551234567', 1), ('b@x.com', 'h2', '5559876543', 1), ('c@x.com', 'h3', NULL, 0);
    INSERT INTO orders (user_id, total) VALUES (1, 10), (1, 20), (2, 5);
  `)
  db.close()
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

const config = (over: Partial<PlainQLConfig> = {}): PlainQLConfig => ({
  connection: { url },
  ai: { provider: 'anthropic', cache: { storage: 'memory' } },
  tables: {
    users: { columns: { hidden: ['password_hash'], masked: { phone: 'last4' } }, maxRows: 10 }
  },
  ...over
})

const ANSWERS = {
  'active users': 'SELECT id, email, phone FROM users WHERE active = 1',
  'user 1': 'SELECT id, email FROM users WHERE id = 1',
  'how many orders': 'SELECT COUNT(*) AS n FROM orders',
  'deactivate user 3': 'UPDATE users SET active = 0 WHERE id = 3',
  'leak hashes': 'SELECT password_hash FROM users',
  'drop it': 'DROP TABLE users',
  'user emails': 'SELECT email FROM users'
}

describe('PlainQL — lifecycle', () => {
  it('refuses every query method before connect()', async () => {
    const pql = new PlainQL({ config: config(), aiProvider: fakeProvider({}) })
    await expect(pql.get('x')).rejects.toThrow('PlainQL: call connect() before running queries')
    await expect(pql.run('x')).rejects.toThrow(/connect\(\)/)
    await expect(pql.query('x')).rejects.toThrow(/connect\(\)/)
    await expect(pql.preview('x')).rejects.toThrow(/connect\(\)/)
    await expect(pql.explain('x')).rejects.toThrow(/connect\(\)/)
    expect(() => pql.cacheStats()).toThrow(/connect\(\)/)
  })

  it('connects once and disconnects cleanly', async () => {
    const pql = new PlainQL({ config: config(), aiProvider: fakeProvider(ANSWERS) })
    await pql.connect()
    await pql.connect()
    expect(pql.schemaContext().tables.map((t) => t.name).sort()).toEqual(['orders', 'users'])
    await pql.disconnect()
    await expect(pql.get('active users')).rejects.toThrow(/connect\(\)/)
  })
})

describe('PlainQL — reads', () => {
  it('get() runs the generated SQL and masks the result', async () => {
    const provider = fakeProvider(ANSWERS)
    const pql = new PlainQL({ config: config(), aiProvider: provider })
    await pql.connect()

    const rows = await pql.get('active users')
    expect(rows).toEqual([
      { id: 1, email: 'a@x.com', phone: '******4567' },
      { id: 2, email: 'b@x.com', phone: '******6543' }
    ])
    expect(pql.last()).toMatchObject({
      source: 'ai', executed: true, operation: 'SELECT', tables: ['users'], tokens: 500,
      sql: 'SELECT id, email, phone FROM users WHERE active = 1 LIMIT 10'
    })
    expect(provider.seen[0]!.system).not.toContain('password_hash')
  })

  it('first() returns one row or null', async () => {
    const pql = new PlainQL({ config: config(), aiProvider: fakeProvider(ANSWERS) })
    await pql.connect()
    expect(await pql.first('user 1')).toEqual({ id: 1, email: 'a@x.com' })
    expect(await pql.first('deactivate user 3').catch((e: Error) => e.message)).toMatch(/SELECT only/)
  })

  it('count() unwraps a single-cell result', async () => {
    const pql = new PlainQL({ config: config(), aiProvider: fakeProvider(ANSWERS) })
    await pql.connect()
    expect(await pql.count('how many orders')).toBe(3)
    expect(await pql.count('active users')).toBe(2)
  })

  it('explain() returns the plan without executing', async () => {
    const pql = new PlainQL({ config: config(), aiProvider: fakeProvider(ANSWERS) })
    await pql.connect()
    const explained = await pql.explain('active users')
    expect(explained.sql).toContain('FROM users')
    expect(explained.plan.length).toBeGreaterThan(0)
    expect(pql.last()?.executed).toBe(false)
  })
})

describe('PlainQL — writes', () => {
  it('run() executes writes and refuses reads', async () => {
    const pql = new PlainQL({ config: config(), aiProvider: fakeProvider(ANSWERS) })
    await pql.connect()
    await pql.run('deactivate user 3')
    expect(pql.last()).toMatchObject({ operation: 'UPDATE', executed: true })
    await expect(pql.run('active users')).rejects.toThrow(/writes only/)
  })
})

describe('PlainQL — security', () => {
  it('throws a ViolationError and never executes blocked SQL', async () => {
    const pql = new PlainQL({ config: config(), aiProvider: fakeProvider(ANSWERS) })
    await pql.connect()
    await expect(pql.get('leak hashes')).rejects.toBeInstanceOf(ViolationError)
    await expect(pql.get('drop it')).rejects.toThrow(/blocked/)
    expect(pql.last()).toBeUndefined()
  })

  it('does not cache SQL that failed validation', async () => {
    const provider = fakeProvider(ANSWERS)
    const pql = new PlainQL({ config: config(), aiProvider: provider })
    await pql.connect()
    await pql.get('leak hashes').catch(() => undefined)
    await pql.get('leak hashes').catch(() => undefined)
    expect(provider.seen).toHaveLength(2)
  })

  it('preview() reports blocked SQL with layer and reason, executing nothing', async () => {
    const pql = new PlainQL({ config: config(), aiProvider: fakeProvider(ANSWERS) })
    await pql.connect()

    expect(await pql.preview('leak hashes')).toMatchObject({ blocked: true, layer: 2, sql: 'SELECT password_hash FROM users' })
    expect(await pql.preview('active users')).toMatchObject({
      blocked: false, operation: 'SELECT', tables: ['users'],
      sql: 'SELECT id, email, phone FROM users WHERE active = 1 LIMIT 10'
    })
  })

  it('dryRun validates and returns nothing', async () => {
    const pql = new PlainQL({ config: config({ security: { dryRun: true } }), aiProvider: fakeProvider(ANSWERS) })
    await pql.connect()
    expect(await pql.get('active users')).toEqual([])
    expect(pql.last()).toMatchObject({ executed: false, sql: expect.stringContaining('FROM users') })
    await expect(pql.get('leak hashes')).rejects.toBeInstanceOf(ViolationError)
  })

  it("onViolation: 'warn' logs, skips execution and reports through preview()", async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const pql = new PlainQL({ config: config({ security: { onViolation: 'warn' } }), aiProvider: fakeProvider(ANSWERS) })
    await pql.connect()

    expect(await pql.get('leak hashes')).toEqual([])
    expect(pql.last()).toMatchObject({ executed: false })
    expect(warn).toHaveBeenCalled()
    expect(await pql.preview('leak hashes')).toMatchObject({ blocked: true, reason: expect.stringContaining('password_hash') })
    warn.mockRestore()
  })
})

describe('PlainQL — cache and static queries', () => {
  it('serves repeated and rephrased prompts from the cache', async () => {
    const provider = fakeProvider(ANSWERS)
    const pql = new PlainQL({ config: config(), aiProvider: provider })
    await pql.connect()

    await pql.get('active users')
    await pql.get('active users')
    await pql.get('the active users, please')
    expect(provider.seen).toHaveLength(1)
    expect(pql.last()).toMatchObject({ source: 'intent', tokens: 0 })
    expect(pql.cacheStats()).toEqual({ hits: 2, misses: 1, tokensSaved: 1000 })
  })

  it('resolves config.queries at connect() and runs them by name with no tokens', async () => {
    const provider = fakeProvider(ANSWERS)
    const pql = new PlainQL({ config: config({ queries: { emails: 'user emails' } }), aiProvider: provider })
    await pql.connect()
    expect(provider.seen).toHaveLength(1)

    expect(await pql.query('emails')).toEqual([{ email: 'a@x.com' }, { email: 'b@x.com' }, { email: 'c@x.com' }])
    expect(pql.last()).toMatchObject({ source: 'static', tokens: 0, executed: true })
    expect(provider.seen).toHaveLength(1)
    await expect(pql.query('nope')).rejects.toThrow(/unknown static query "nope"/)
  })

  it('persists the file cache across instances', async () => {
    const cacheDir = join(dir, 'cache')
    const cfg = config({ ai: { provider: 'anthropic', cache: { dir: cacheDir } }, queries: { emails: 'user emails' } })

    const first = fakeProvider(ANSWERS)
    const a = new PlainQL({ config: cfg, aiProvider: first })
    await a.connect()
    await a.get('active users')
    await a.disconnect()

    const second = fakeProvider({})
    const b = new PlainQL({ config: cfg, aiProvider: second })
    await b.connect()
    expect(await b.get('active users')).toHaveLength(2)
    expect(await b.query('emails')).toHaveLength(3)
    expect(second.seen).toHaveLength(0)
  })

  it('names the static query when its generation fails', async () => {
    const pql = new PlainQL({ config: config({ queries: { broken: 'no answer' } }), aiProvider: fakeProvider(ANSWERS) })
    await expect(pql.connect()).rejects.toThrow(/static query "broken"/)
  })
})
