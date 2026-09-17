import { describe, it, expect } from 'vitest'
import { RuleSet } from './rules.js'
import { SecurityError } from './violations.js'
import type { PlainQLConfig } from '../config/types.js'

const base = (over: Partial<PlainQLConfig> = {}): PlainQLConfig => ({
  connection: { url: ':memory:' },
  ai: { provider: 'anthropic' },
  ...over
})

describe('RuleSet — table rules alone', () => {
  it('allows every operation when no rule is given', () => {
    const rules = new RuleSet(base())
    expect(rules.forTable('users').allowed.sort()).toEqual(
      ['DELETE', 'INSERT', 'SELECT', 'UPDATE']
    )
  })

  it('honours an explicit allow list', () => {
    const rules = new RuleSet(base({ tables: { users: { allow: ['SELECT'] } } }))
    expect(rules.forTable('users').allowed).toEqual(['SELECT'])
  })

  it('lets deny override allow', () => {
    const rules = new RuleSet(
      base({ tables: { users: { allow: ['SELECT', 'DELETE'], deny: ['DELETE'] } } })
    )
    expect(rules.forTable('users').allowed).toEqual(['SELECT'])
  })

  it('matches table names case-insensitively', () => {
    const rules = new RuleSet(base({ tables: { Users: { allow: ['SELECT'] } } }))
    expect(rules.forTable('users').allowed).toEqual(['SELECT'])
    expect(rules.forTable('USERS').allowed).toEqual(['SELECT'])
  })
})

describe('RuleSet — roles narrow, never widen', () => {
  it('intersects the role allow list with the table one', () => {
    const rules = new RuleSet(
      base({
        tables: { users: { allow: ['SELECT', 'UPDATE'] } },
        roles: { analyst: { tables: { users: { allow: ['SELECT'] } } } }
      }),
      'analyst'
    )
    expect(rules.forTable('users').allowed).toEqual(['SELECT'])
  })

  it('refuses to let a role add an operation the table forbids', () => {
    const rules = new RuleSet(
      base({
        tables: { users: { allow: ['SELECT'] } },
        roles: { rogue: { tables: { users: { allow: ['SELECT', 'DELETE'] } } } }
      }),
      'rogue'
    )
    expect(rules.forTable('users').allowed).toEqual(['SELECT'])
  })

  it('refuses to let a role unhide a hidden column', () => {
    const rules = new RuleSet(
      base({
        tables: { users: { columns: { hidden: ['password'] } } },
        roles: { rogue: { tables: { users: { columns: { hidden: [] } } } } }
      }),
      'rogue'
    )
    expect(rules.forTable('users').hidden).toEqual(['password'])
  })

  it('accumulates hidden columns from both sides', () => {
    const rules = new RuleSet(
      base({
        tables: { users: { columns: { hidden: ['password'] } } },
        roles: { analyst: { tables: { users: { columns: { hidden: ['ssn'] } } } } }
      }),
      'analyst'
    )
    expect(rules.forTable('users').hidden.sort()).toEqual(['password', 'ssn'])
  })

  it('takes the tighter maxRows', () => {
    const rules = new RuleSet(
      base({
        tables: { users: { maxRows: 100 } },
        roles: { analyst: { tables: { users: { maxRows: 10 } } } }
      }),
      'analyst'
    )
    expect(rules.forTable('users').maxRows).toBe(10)
  })

  it('refuses to let a role raise maxRows', () => {
    const rules = new RuleSet(
      base({
        tables: { users: { maxRows: 10 } },
        roles: { rogue: { tables: { users: { maxRows: 1000 } } } }
      }),
      'rogue'
    )
    expect(rules.forTable('users').maxRows).toBe(10)
  })

  it('caps every table with globalAllow', () => {
    const rules = new RuleSet(
      base({
        tables: { users: { allow: ['SELECT', 'DELETE'] } },
        roles: { readonly: { globalAllow: ['SELECT'] } }
      }),
      'readonly'
    )
    expect(rules.forTable('users').allowed).toEqual(['SELECT'])
  })

  it('applies globalAllow to tables with no rule at all', () => {
    const rules = new RuleSet(
      base({ roles: { readonly: { globalAllow: ['SELECT'] } } }),
      'readonly'
    )
    expect(rules.forTable('anything').allowed).toEqual(['SELECT'])
  })

  it('intersects writable only when both sides constrain it', () => {
    const rules = new RuleSet(
      base({
        tables: { users: { columns: { writable: ['name', 'email'] } } },
        roles: { analyst: { tables: { users: { columns: { writable: ['name'] } } } } }
      }),
      'analyst'
    )
    expect(rules.forTable('users').writable).toEqual(['name'])
  })

  it('leaves writable undefined when nobody constrains it', () => {
    const rules = new RuleSet(base({ tables: { users: {} } }))
    expect(rules.forTable('users').writable).toBeUndefined()
  })
})

describe('RuleSet — extends chain', () => {
  it('narrows through the whole chain, base first', () => {
    const rules = new RuleSet(
      base({
        tables: { users: { allow: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] } },
        roles: {
          staff: { tables: { users: { allow: ['SELECT', 'INSERT', 'UPDATE'] } } },
          analyst: { extends: 'staff', tables: { users: { allow: ['SELECT', 'INSERT'] } } },
          intern: { extends: 'analyst', tables: { users: { allow: ['SELECT'] } } }
        }
      }),
      'intern'
    )
    expect(rules.forTable('users').allowed).toEqual(['SELECT'])
  })

  it('keeps restrictions inherited from every ancestor', () => {
    const rules = new RuleSet(
      base({
        roles: {
          staff: { tables: { users: { columns: { hidden: ['password'] } } } },
          intern: { extends: 'staff', tables: { users: { columns: { hidden: ['ssn'] } } } }
        }
      }),
      'intern'
    )
    expect(rules.forTable('users').hidden.sort()).toEqual(['password', 'ssn'])
  })

  it('refuses a child that tries to widen its parent', () => {
    const rules = new RuleSet(
      base({
        roles: {
          staff: { globalAllow: ['SELECT'] },
          rogue: { extends: 'staff', globalAllow: ['SELECT', 'DELETE'] }
        }
      }),
      'rogue'
    )
    expect(rules.forTable('users').allowed).toEqual(['SELECT'])
  })

  it('throws on an unknown role rather than failing open', () => {
    expect(() => new RuleSet(base({ roles: {} }), 'ghost')).toThrow(SecurityError)
  })

  it('throws on a missing parent role', () => {
    expect(() =>
      new RuleSet(base({ roles: { child: { extends: 'ghost' } } }), 'child')
    ).toThrow(/unknown role "ghost"/)
  })

  it('throws on circular inheritance instead of looping forever', () => {
    expect(() =>
      new RuleSet(
        base({ roles: { a: { extends: 'b' }, b: { extends: 'a' } } }),
        'a'
      )
    ).toThrow(/circular/)
  })
})

describe('RuleSet — introspection helpers', () => {
  it('reports tables carrying column rules', () => {
    const rules = new RuleSet(
      base({
        tables: {
          users: { columns: { hidden: ['password'] } },
          cards: { columns: { masked: { number: 'last4' } } },
          logs: { allow: ['SELECT'] }
        }
      })
    )
    expect(rules.tablesWithColumnRules().sort()).toEqual(['cards', 'users'])
  })

  it('knows which tables the config names', () => {
    const rules = new RuleSet(base({ tables: { users: {} } }))
    expect(rules.isKnownTable('users')).toBe(true)
    expect(rules.isKnownTable('ghosts')).toBe(false)
  })
})
