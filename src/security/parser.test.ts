import { describe, it, expect } from 'vitest'
import { SqlParser } from './parser.js'
import { SecurityError } from './violations.js'
import { Dialect } from '../schema/types.js'

const parser = new SqlParser(Dialect.SQLite)

describe('SqlParser — operations', () => {
  it('detects each operation', () => {
    expect(parser.parse('SELECT id FROM users').operation).toBe('SELECT')
    expect(parser.parse("INSERT INTO users (id) VALUES (1)").operation).toBe('INSERT')
    expect(parser.parse("UPDATE users SET id = 1 WHERE id = 2").operation).toBe('UPDATE')
    expect(parser.parse('DELETE FROM users WHERE id = 1').operation).toBe('DELETE')
  })
})

describe('SqlParser — tables', () => {
  it('collects joined tables, not just the first FROM', () => {
    const r = parser.parse(
      'SELECT u.email FROM users u JOIN orders o ON o.user_id = u.id'
    )
    expect(r.tables.sort()).toEqual(['orders', 'users'])
  })

  it('reaches tables hidden inside a subquery', () => {
    const r = parser.parse('SELECT * FROM users WHERE id IN (SELECT user_id FROM secrets)')
    expect(r.tables.sort()).toEqual(['secrets', 'users'])
  })

  it('reaches tables inside a nested subquery', () => {
    const r = parser.parse(
      'SELECT * FROM a WHERE id IN (SELECT id FROM b WHERE x IN (SELECT y FROM c))'
    )
    expect(r.tables.sort()).toEqual(['a', 'b', 'c'])
  })
})

describe('SqlParser — alias resolution', () => {
  it('rewrites aliases to real table names', () => {
    const r = parser.parse(
      'SELECT u.email, o.total FROM users u JOIN orders o ON o.user_id = u.id'
    )
    expect(r.readColumns).toContainEqual({ table: 'users', column: 'email' })
    expect(r.readColumns).toContainEqual({ table: 'orders', column: 'total' })
  })

  it('binds an unqualified column to the only table in play', () => {
    const r = parser.parse('SELECT email FROM users')
    expect(r.readColumns).toContainEqual({ table: 'users', column: 'email' })
  })

  it('leaves an unqualified column unresolved when several tables are in play', () => {
    const r = parser.parse('SELECT email FROM users u JOIN orders o ON o.user_id = u.id')
    expect(r.readColumns).toContainEqual({ table: undefined, column: 'email' })
  })

  it('sees columns used only in WHERE', () => {
    const r = parser.parse('SELECT id FROM users WHERE password = 1')
    expect(r.readColumns).toContainEqual({ table: 'users', column: 'password' })
  })

  it('sees SELECT * as a read of *', () => {
    const r = parser.parse('SELECT * FROM users')
    expect(r.readColumns).toContainEqual({ table: 'users', column: '*' })
  })
})

describe('SqlParser — write columns', () => {
  it('lists UPDATE SET targets as writes', () => {
    const r = parser.parse("UPDATE users SET email = 'x', role = 'admin' WHERE id = 5")
    expect(r.writeColumns).toContainEqual({ table: 'users', column: 'email' })
    expect(r.writeColumns).toContainEqual({ table: 'users', column: 'role' })
  })

  it('does not count a WHERE column as a write', () => {
    const r = parser.parse("UPDATE users SET email = 'x' WHERE id = 5")
    expect(r.writeColumns.map((c) => c.column)).toEqual(['email'])
    expect(r.readColumns).toContainEqual({ table: 'users', column: 'id' })
  })

  it('lists INSERT columns as writes bound to the target table', () => {
    const r = parser.parse("INSERT INTO users (email, name) VALUES ('a', 'b')")
    expect(r.writeColumns).toContainEqual({ table: 'users', column: 'email' })
    expect(r.writeColumns).toContainEqual({ table: 'users', column: 'name' })
  })
})

describe('SqlParser — where and limit', () => {
  it('flags a missing WHERE', () => {
    expect(parser.parse('DELETE FROM users').hasWhere).toBe(false)
    expect(parser.parse('DELETE FROM users WHERE id = 1').hasWhere).toBe(true)
  })

  it('exposes where text lowercased for condition matching', () => {
    const r = parser.parse("DELETE FROM users WHERE Tenant_Id = 'x'")
    expect(r.whereText).toContain('tenant_id')
  })

  it('stops where text at LIMIT', () => {
    const r = parser.parse('SELECT id FROM users WHERE active = 1 LIMIT 10')
    expect(r.whereText).toBe('active = 1')
  })

  it('reads a numeric limit', () => {
    expect(parser.parse('SELECT id FROM users LIMIT 10').limit).toBe(10)
    expect(parser.parse('SELECT id FROM users').limit).toBeUndefined()
  })

  it('takes the row count, not the offset', () => {
    expect(parser.parse('SELECT id FROM users LIMIT 5, 25').limit).toBe(25)
  })
})

describe('SqlParser — refusals', () => {
  it('refuses empty SQL', () => {
    expect(() => parser.parse('   ')).toThrow(SecurityError)
  })

  it('refuses unparseable SQL', () => {
    expect(() => parser.parse('SELECT FROM WHERE ((')).toThrow(SecurityError)
  })

  it('refuses chained statements', () => {
    expect(() => parser.parse('SELECT * FROM users; DELETE FROM users')).toThrow(
      /multiple SQL statements/
    )
  })

  it('refuses statement types it does not model', () => {
    expect(() => parser.parse('DROP TABLE users')).toThrow(SecurityError)
  })
})

describe('SqlParser — dialects', () => {
  it('parses per dialect', () => {
    expect(new SqlParser(Dialect.PostgreSQL).parse('SELECT id FROM users').tables).toEqual(['users'])
    expect(new SqlParser(Dialect.MySQL).parse('SELECT id FROM users').tables).toEqual(['users'])
  })
})
