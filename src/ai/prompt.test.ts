import { describe, it, expect } from 'vitest'
import { PromptBuilder } from './prompt.js'
import { RuleSet } from '../security/rules.js'
import type { PlainQLConfig } from '../config/types.js'
import { Dialect, type ColumnInfo, type SchemaContext, type TableInfo } from '../schema/types.js'

const column = (name: string, over: Partial<ColumnInfo> = {}): ColumnInfo => ({
  name,
  type: 'text',
  nullable: false,
  isPrimary: false,
  isUnique: false,
  defaultValue: null,
  ...over
})

const table = (name: string, columns: ColumnInfo[], over: Partial<TableInfo> = {}): TableInfo => ({
  name,
  columns,
  indexes: [],
  ...over
})

const id = column('id', { type: 'integer', isPrimary: true })

const schema = (): SchemaContext => ({
  dialect: Dialect.SQLite,
  tables: [
    table('users', [id, column('email'), column('password_hash'), column('status', { nullable: true })], {
      rowCount: 120,
      indexes: [
        { name: 'pk', columns: ['id'], isUnique: true },
        { name: 'users_email', columns: ['email'], isUnique: true },
        { name: 'users_status', columns: ['status'], isUnique: false }
      ]
    }),
    table('orders', [id, column('user_id', { type: 'integer' }), column('total', { type: 'real' })]),
    table('audit_logs', [id, column('actor'), column('payload')])
  ],
  relations: [{ fromTable: 'orders', fromColumn: 'user_id', toTable: 'users', toColumn: 'id' }]
})

const config = (over: Partial<PlainQLConfig> = {}): PlainQLConfig => ({
  connection: { url: ':memory:' },
  ai: { provider: 'anthropic' },
  ...over
})

const builder = (over: Partial<PlainQLConfig> = {}, role?: string, maxTables?: number) =>
  new PromptBuilder(new RuleSet(config(over), role), { maxTables })

/** A zero budget forces the per-call table selection even on a tiny schema. */
const selective = (over: Partial<PlainQLConfig> = {}, role?: string, maxTables?: number) =>
  new PromptBuilder(new RuleSet(config(over), role), { maxTables, maxSchemaTokens: 0 })

describe('PromptBuilder — role filter', () => {
  it('strips hidden columns and the indexes that use them', () => {
    const filtered = builder({
      tables: { users: { columns: { hidden: ['password_hash', 'email'] } } }
    }).filterSchema(schema())

    const users = filtered.tables.find((t) => t.name === 'users')!
    expect(users.columns.map((c) => c.name)).toEqual(['id', 'status'])
    expect(users.indexes.map((i) => i.name)).toEqual(['pk', 'users_status'])
  })

  it('drops tables the role may not touch at all, and their relations', () => {
    const filtered = builder({
      roles: { support: { tables: { users: { deny: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] } } } }
    }, 'support').filterSchema(schema())

    expect(filtered.tables.map((t) => t.name)).toEqual(['orders', 'audit_logs'])
    expect(filtered.relations).toEqual([])
  })

  it('never mentions a hidden column anywhere in the prompt', () => {
    const prompt = builder({
      tables: { users: { columns: { hidden: ['password_hash'] } } }
    }).build('list users', schema())

    expect(prompt.user).not.toContain('password_hash')
    expect(prompt.system).not.toContain('password_hash')
  })
})

describe('PromptBuilder — full mode', () => {
  it('puts the whole schema in the system prompt and only the request in the user turn', () => {
    const prompt = builder().build('users and their orders', schema())

    expect(prompt.mode).toBe('full')
    expect(prompt.tables).toEqual(['users', 'orders', 'audit_logs'])
    expect(prompt.system).toContain('Schema (sqlite):')
    expect(prompt.system).toContain('users(id integer pk, email text, password_hash text, status text?) ~120 rows')
    expect(prompt.system).toContain('  unique(email) idx(status)')
    expect(prompt.system).toContain('orders(id integer pk, user_id integer -> users.id, total real)')
    expect(prompt.system).not.toContain('Other tables')
    expect(prompt.system).not.toContain('needTables": ["name"')
    expect(prompt.user).toBe('Request: users and their orders')
  })

  it('is byte-identical across requests so the provider can cache it', () => {
    const a = builder().build('first question', schema())
    const b = builder().build('a completely different one', schema())
    expect(a.system).toBe(b.system)
  })

  it('asks for JSON only and names the dialect', () => {
    const prompt = builder().build('anything', schema())
    expect(prompt.system).toContain('sqlite')
    expect(prompt.system).toContain('{"sql": "...", "needTables": []}')
  })

  it('falls back to selection once the schema exceeds the token budget', () => {
    const prompt = selective().build('anything', schema())
    expect(prompt.mode).toBe('selected')
    expect(prompt.system).not.toContain('Schema (')
    expect(prompt.system).toContain('needTables": ["name"')
    expect(prompt.user).toContain('Schema:')
  })
})

describe('PromptBuilder — notes', () => {
  const noted = (): Partial<PlainQLConfig> => ({
    context: 'Amounts are in cents.\n  Gift lines are order lines with a reward.',
    tables: {
      users: {
        description: 'People who can log in',
        columns: {
          hidden: ['password_hash'],
          hints: {
            status: 'one of active | banned | pending',
            password_hash: 'bcrypt',
            ghost: 'does not exist'
          }
        }
      }
    }
  })

  it('emits domain notes and table/column notes in the system prompt', () => {
    const prompt = builder(noted()).build('anything', schema())

    expect(prompt.system).toContain('Domain notes:\nAmounts are in cents.\n  Gift lines are order lines with a reward.')
    expect(prompt.system).toContain('users(id integer pk, email text, status text?) ~120 rows\n  unique(email) idx(status)\n  note: People who can log in\n  note status: one of active | banned | pending')
    expect(prompt.system).toContain('Lines starting with "note:"')
  })

  it('never emits a hint for a hidden or unknown column', () => {
    const prompt = builder(noted()).build('anything', schema())
    expect(prompt.system).not.toContain('bcrypt')
    expect(prompt.system).not.toContain('ghost')
  })

  it('emits notes in selected mode too, next to the described table', () => {
    const prompt = selective(noted()).build('users', schema())
    expect(prompt.user).toContain('  note: People who can log in')
    expect(prompt.system).toContain('Domain notes:')
  })

  it('lets a role override the description and add hints', () => {
    const prompt = builder({
      ...noted(),
      roles: {
        support: {
          tables: { users: { description: 'Customers you may contact', columns: { hints: { email: 'lowercase' } } } }
        }
      }
    }, 'support').build('anything', schema())

    expect(prompt.system).toContain('  note: Customers you may contact')
    expect(prompt.system).toContain('  note status: one of active')
    expect(prompt.system).toContain('  note email: lowercase')
    expect(prompt.system).not.toContain('People who can log in')
  })

  it('collapses multi-line notes to one line', () => {
    const prompt = builder({
      tables: { orders: { description: 'One row per\n   checkout' } }
    }).build('anything', schema())
    expect(prompt.system).toContain('  note: One row per checkout')
  })
})

describe('PromptBuilder — serialisation', () => {
  it('writes one compact line per table with pk, nullable and relations inline', () => {
    const prompt = selective().build('users and their orders', schema())

    expect(prompt.user).toContain('users(id integer pk, email text, password_hash text, status text?) ~120 rows')
    expect(prompt.user).toContain('  unique(email) idx(status)')
    expect(prompt.user).toContain('orders(id integer pk, user_id integer -> users.id, total real)')
    expect(prompt.user).toContain('Dialect: sqlite')
    expect(prompt.user.endsWith('Request: users and their orders')).toBe(true)
  })

  it('rejects an empty intent', () => {
    expect(() => builder().build('   ', schema())).toThrow(/intent must not be empty/)
  })
})

describe('PromptBuilder — table selection', () => {
  const wide = (): SchemaContext => {
    const base = schema()
    const filler = Array.from({ length: 30 }, (_, i) =>
      table(`filler_${i}`, [id, column('note')])
    )
    return {
      ...base,
      tables: [...filler, ...base.tables, table('order_items', [id, column('order_id', { type: 'integer' }), column('sku')])],
      relations: [
        ...base.relations,
        { fromTable: 'order_items', fromColumn: 'order_id', toTable: 'orders', toColumn: 'id' }
      ]
    }
  }

  it('sends every table in full when the schema is small', () => {
    const prompt = selective().build('whatever', schema())
    expect(prompt.tables).toEqual(['users', 'orders', 'audit_logs'])
    expect(prompt.user).not.toContain('Other tables')
  })

  it('picks tables named in the intent and pulls in their relations', () => {
    const prompt = selective({}, undefined, 4).build('How many orders did each user place?', wide())

    expect(prompt.tables.slice(0, 2).sort()).toEqual(['orders', 'users'])
    expect(prompt.tables).toContain('order_items')
    expect(prompt.tables).not.toContain('audit_logs')
    expect(prompt.user).toContain('Other tables (columns omitted):')
    expect(prompt.user).toContain('filler_0')
  })

  it('matches singular intent words against plural table names', () => {
    const prompt = selective({}, undefined, 2).build('find the audit log for actor 7', wide())
    expect(prompt.tables[0]).toBe('audit_logs')
  })

  it('sends names only when nothing matches, so the model asks instead of guessing', () => {
    const prompt = selective({}, undefined, 3).build('rastgele kullanıcının satışları', wide())
    expect(prompt.tables).toEqual([])
    expect(prompt.user).not.toContain('Schema:')
    expect(prompt.user).toContain('Other tables (columns omitted):')
    expect(prompt.user).toContain('users, orders, audit_logs, order_items')
  })

  it('describes pinned tables in full ahead of the selection', () => {
    const prompt = selective({}, undefined, 2).build('zzz', wide(), ['ORDERS', 'nope', 'users'])
    expect(prompt.tables).toEqual(['users', 'orders'])
    expect(prompt.user).toContain('orders(id integer pk, user_id integer -> users.id, total real)')
  })

  it('never pins a table the role cannot see', () => {
    const prompt = selective({
      roles: { support: { tables: { users: { deny: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] } } } }
    }, 'support', 2).build('zzz', wide(), ['users'])
    expect(prompt.tables).toEqual([])
  })
})
