import { describe, it, expect, vi } from 'vitest'
import { SecurityValidator } from './validator.js'
import { SecurityError, ViolationError } from './violations.js'
import { Dialect } from '../schema/types.js'
import type { PlainQLConfig } from '../config/types.js'

const make = (over: Partial<PlainQLConfig> = {}, role?: string) =>
  new SecurityValidator(
    { connection: { url: ':memory:' }, ai: { provider: 'anthropic' }, ...over },
    Dialect.SQLite,
    role
  )

const layerOf = (fn: () => unknown): number => {
  try {
    fn()
  } catch (error) {
    if (error instanceof ViolationError) return error.layer
    throw error
  }
  throw new Error('expected a violation')
}

describe('Layer 1 — global blocklist', () => {
  it('blocks schema-destroying keywords', () => {
    for (const sql of ['DROP TABLE users', 'TRUNCATE TABLE users', 'ALTER TABLE users ADD x INT']) {
      expect(() => make().validate(sql)).toThrow(ViolationError)
    }
  })

  it('reports the blocklist as layer 1', () => {
    expect(layerOf(() => make().validate('DROP TABLE users'))).toBe(1)
  })

  it('blocks chained statements', () => {
    expect(() => make().validate('SELECT * FROM users; DELETE FROM users')).toThrow(
      /multiple SQL statements/
    )
  })

  it('allows a trailing semicolon', () => {
    expect(make().validate('SELECT id FROM users;').sql).toContain('SELECT')
  })

  it('honours extra blocked operations from config', () => {
    const v = make({ security: { blockedOperations: ['ATTACH', 'PRAGMA'] } })
    expect(() => v.validate('PRAGMA table_info(users)')).toThrow(ViolationError)
  })

  it('cannot be softened by onViolation: ignore', () => {
    const v = make({ security: { onViolation: 'ignore' } })
    expect(() => v.validate('DROP TABLE users')).toThrow(ViolationError)
  })

  it('does not trip on a keyword inside a string literal', () => {
    expect(() => make().validate("SELECT id FROM users WHERE note = 'DROP me'")).not.toThrow()
  })

  it('does not trip on a column whose name contains a keyword', () => {
    expect(() => make().validate('SELECT dropped_at FROM users')).not.toThrow()
  })
})

describe('Layer 2 — table rules', () => {
  it('blocks an operation the table denies', () => {
    const v = make({ tables: { users: { allow: ['SELECT'] } } })
    expect(() => v.validate('DELETE FROM users WHERE id = 1')).toThrow(
      /DELETE is not allowed on table "users"/
    )
  })

  it('reports table rules as layer 2', () => {
    const v = make({ tables: { users: { allow: ['SELECT'] } } })
    expect(layerOf(() => v.validate('DELETE FROM users WHERE id = 1'))).toBe(2)
  })

  it('blocks a denied table reached only through a JOIN', () => {
    const v = make({ tables: { secrets: { allow: [] } } })
    expect(() =>
      v.validate('SELECT u.id FROM users u JOIN secrets s ON s.user_id = u.id')
    ).toThrow(/not allowed on table "secrets"/)
  })

  it('blocks a denied table hidden in a subquery', () => {
    const v = make({ tables: { secrets: { allow: [] } } })
    expect(() =>
      v.validate('SELECT * FROM users WHERE id IN (SELECT user_id FROM secrets)')
    ).toThrow(/not allowed on table "secrets"/)
  })
})

describe('Layer 2 — hidden columns', () => {
  const config = { tables: { users: { columns: { hidden: ['password'] } } } }

  it('blocks selecting a hidden column', () => {
    expect(() => make(config).validate('SELECT password FROM users')).toThrow(
      /"password".*is hidden/
    )
  })

  it('blocks a hidden column reached through an alias', () => {
    expect(() => make(config).validate('SELECT u.password FROM users u')).toThrow(
      /"password".*is hidden/
    )
  })

  it('blocks a hidden column used only in WHERE', () => {
    expect(() =>
      make(config).validate("SELECT id FROM users WHERE password = 'x'")
    ).toThrow(/"password".*is hidden/)
  })

  it('blocks SELECT * on a table with hidden columns', () => {
    expect(() => make(config).validate('SELECT * FROM users')).toThrow(/SELECT \* is not allowed/)
  })

  it('blocks a hidden column inside a subquery', () => {
    expect(() =>
      make(config).validate('SELECT id FROM orders WHERE x IN (SELECT password FROM users)')
    ).toThrow(/"password".*is hidden/)
  })

  it('allows non-hidden columns', () => {
    expect(() => make(config).validate('SELECT id, email FROM users')).not.toThrow()
  })

  it('does not mistake an output alias for a column', () => {
    const v = make({ tables: { orders: { columns: { hidden: ['secret'] } } } })
    expect(() =>
      v.validate('SELECT SUM(total) AS secret_total FROM orders ORDER BY secret_total DESC')
    ).not.toThrow()
  })
})

describe('Layer 2 — write columns', () => {
  it('blocks writing a readonly column', () => {
    const v = make({ tables: { users: { columns: { readonly: ['id'] } } } })
    expect(() => v.validate('UPDATE users SET id = 2 WHERE id = 1')).toThrow(/is read-only/)
  })

  it('allows a readonly column in WHERE', () => {
    const v = make({ tables: { users: { columns: { readonly: ['id'] } } } })
    expect(() => v.validate("UPDATE users SET email = 'x' WHERE id = 1")).not.toThrow()
  })

  it('blocks a column outside the writable list', () => {
    const v = make({ tables: { users: { columns: { writable: ['email'] } } } })
    expect(() => v.validate("UPDATE users SET role = 'admin' WHERE id = 1")).toThrow(
      /is not writable/
    )
  })

  it('allows a column inside the writable list', () => {
    const v = make({ tables: { users: { columns: { writable: ['email'] } } } })
    expect(() => v.validate("UPDATE users SET email = 'x' WHERE id = 1")).not.toThrow()
  })

  it('blocks INSERT into a non-writable column', () => {
    const v = make({ tables: { users: { columns: { writable: ['email'] } } } })
    expect(() => v.validate("INSERT INTO users (role) VALUES ('admin')")).toThrow(
      /is not writable/
    )
  })

  it('blocks writing a hidden column', () => {
    const v = make({ tables: { users: { columns: { hidden: ['password'] } } } })
    expect(() => v.validate("UPDATE users SET password = 'x' WHERE id = 1")).toThrow(
      /hidden and cannot be written/
    )
  })
})

describe('Layer 3 — role permissions', () => {
  const config: Partial<PlainQLConfig> = {
    tables: { users: { allow: ['SELECT', 'UPDATE', 'DELETE'] } },
    roles: {
      analyst: { tables: { users: { allow: ['SELECT'] } } },
      readonly: { globalAllow: ['SELECT'] }
    }
  }

  it('blocks what the role withholds', () => {
    const v = make(config, 'analyst')
    expect(() => v.validate('DELETE FROM users WHERE id = 1')).toThrow(/role does not permit/)
  })

  it('reports role refusals as layer 3, not layer 2', () => {
    const v = make(config, 'analyst')
    expect(layerOf(() => v.validate('DELETE FROM users WHERE id = 1'))).toBe(3)
  })

  it('still reports table refusals as layer 2 when a role is active', () => {
    const v = make(
      { tables: { users: { allow: ['SELECT'] } }, roles: { analyst: {} } },
      'analyst'
    )
    expect(layerOf(() => v.validate('DELETE FROM users WHERE id = 1'))).toBe(2)
  })

  it('applies globalAllow across every table', () => {
    const v = make(config, 'readonly')
    expect(() => v.validate("UPDATE users SET email = 'x' WHERE id = 1")).toThrow(ViolationError)
    expect(() => v.validate('SELECT id FROM users')).not.toThrow()
  })

  it('refuses an unknown role instead of running unrestricted', () => {
    expect(() => make(config, 'ghost')).toThrow(SecurityError)
  })
})

describe('Layer 4 — statement shape', () => {
  it('blocks UPDATE without WHERE when required globally', () => {
    const v = make({ security: { requireWhereClause: true } })
    expect(() => v.validate("UPDATE users SET active = 0")).toThrow(/requires a WHERE clause/)
  })

  it('blocks DELETE without WHERE when required globally', () => {
    const v = make({ security: { requireWhereClause: true } })
    expect(layerOf(() => v.validate('DELETE FROM users'))).toBe(4)
  })

  it('allows UPDATE with WHERE', () => {
    const v = make({ security: { requireWhereClause: true } })
    expect(() => v.validate('UPDATE users SET active = 0 WHERE id = 1')).not.toThrow()
  })

  it('honours per-table requireWhere', () => {
    const v = make({ tables: { users: { requireWhere: ['DELETE'] } } })
    expect(() => v.validate('DELETE FROM users')).toThrow(/requires a WHERE clause/)
    expect(() => v.validate('DELETE FROM users WHERE id = 1')).not.toThrow()
  })

  it('enforces deletePolicy.requireCondition', () => {
    const v = make({
      tables: { users: { deletePolicy: { requireCondition: 'tenant_id' } } }
    })
    expect(() => v.validate('DELETE FROM users WHERE id = 1')).toThrow(/requires condition/)
    expect(() =>
      v.validate("DELETE FROM users WHERE tenant_id = 'a' AND id = 1")
    ).not.toThrow()
  })
})

describe('Layer 4 — maxRows', () => {
  it('appends LIMIT when missing', () => {
    const v = make({ tables: { users: { maxRows: 100 } } })
    const result = v.validate('SELECT id FROM users')
    expect(result.sql).toMatch(/LIMIT 100$/)
    expect(result.warnings[0]).toContain('applied LIMIT 100')
  })

  it('tightens a LIMIT that is too large', () => {
    const v = make({ tables: { users: { maxRows: 100 } } })
    const result = v.validate('SELECT id FROM users LIMIT 5000')
    expect(result.sql).toMatch(/LIMIT 100$/)
    expect(result.sql).not.toContain('5000')
  })

  it('leaves a smaller LIMIT alone', () => {
    const v = make({ tables: { users: { maxRows: 100 } } })
    const result = v.validate('SELECT id FROM users LIMIT 10')
    expect(result.sql).toContain('LIMIT 10')
    expect(result.warnings).toEqual([])
  })

  it('uses the tightest cap across joined tables', () => {
    const v = make({ tables: { users: { maxRows: 100 }, orders: { maxRows: 10 } } })
    const result = v.validate('SELECT u.id FROM users u JOIN orders o ON o.user_id = u.id')
    expect(result.sql).toMatch(/LIMIT 10$/)
  })

  it('does not add LIMIT to writes', () => {
    const v = make({ tables: { users: { maxRows: 10 } } })
    expect(v.validate("UPDATE users SET email = 'x' WHERE id = 1").sql).not.toMatch(/LIMIT/i)
  })
})

describe('onViolation modes', () => {
  it('collects warnings instead of throwing in warn mode', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const v = make({
      security: { onViolation: 'warn' },
      tables: { users: { allow: ['SELECT'] } }
    })
    const result = v.validate('DELETE FROM users WHERE id = 1')
    expect(result.warnings.some((w) => /not allowed/.test(w))).toBe(true)
    spy.mockRestore()
  })

  it('stays silent in ignore mode', () => {
    const v = make({
      security: { onViolation: 'ignore' },
      tables: { users: { allow: ['SELECT'] } }
    })
    expect(v.validate('DELETE FROM users WHERE id = 1').warnings).toEqual([])
  })
})

describe('unparseable SQL', () => {
  it('raises SecurityError, not a violation', () => {
    expect(() => make().validate('SELECT FROM WHERE ((')).toThrow(SecurityError)
  })

  it('refuses empty SQL', () => {
    expect(() => make().validate('   ')).toThrow(SecurityError)
  })
})

describe('clean queries', () => {
  it('passes a valid query through untouched', () => {
    const result = make().validate('SELECT id, email FROM users WHERE active = 1 LIMIT 10')
    expect(result.sql).toBe('SELECT id, email FROM users WHERE active = 1 LIMIT 10')
    expect(result.operation).toBe('SELECT')
    expect(result.tables).toEqual(['users'])
    expect(result.warnings).toEqual([])
  })
})
