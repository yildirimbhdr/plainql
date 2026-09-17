import { describe, it, expect } from 'vitest'
import { ResultMasker } from './mask.js'
import { RuleSet } from './rules.js'
import type { PlainQLConfig } from '../config/types.js'

const masker = (over: Partial<PlainQLConfig> = {}, role?: string) =>
  new ResultMasker(
    new RuleSet(
      { connection: { url: ':memory:' }, ai: { provider: 'anthropic' }, ...over },
      role
    )
  )

describe('ResultMasker — hidden columns', () => {
  const config = { tables: { users: { columns: { hidden: ['password'] } } } }

  it('strips a hidden column from every row', () => {
    const rows = [
      { id: 1, email: 'a@b.com', password: 'secret' },
      { id: 2, email: 'c@d.com', password: 'hunter2' }
    ]
    expect(masker(config).apply(rows, ['users'])).toEqual([
      { id: 1, email: 'a@b.com' },
      { id: 2, email: 'c@d.com' }
    ])
  })

  it('matches column names case-insensitively', () => {
    const rows = [{ id: 1, PASSWORD: 'secret', Password: 'again' }]
    expect(masker(config).apply(rows, ['users'])).toEqual([{ id: 1 }])
  })

  it('strips hidden columns from every table involved', () => {
    const m = masker({
      tables: {
        users: { columns: { hidden: ['password'] } },
        orders: { columns: { hidden: ['internal_note'] } }
      }
    })
    const rows = [{ id: 1, password: 'x', internal_note: 'y', total: 10 }]
    expect(m.apply(rows, ['users', 'orders'])).toEqual([{ id: 1, total: 10 }])
  })

  it('also strips columns a role hides', () => {
    const m = masker(
      {
        tables: { users: { columns: { hidden: ['password'] } } },
        roles: { analyst: { tables: { users: { columns: { hidden: ['ssn'] } } } } }
      },
      'analyst'
    )
    const rows = [{ id: 1, password: 'x', ssn: '123', email: 'a@b.com' }]
    expect(m.apply(rows, ['users'])).toEqual([{ id: 1, email: 'a@b.com' }])
  })

  it('returns rows untouched when no rule applies', () => {
    const rows = [{ id: 1, email: 'a@b.com' }]
    expect(masker().apply(rows, ['users'])).toBe(rows)
  })

  it('handles an empty result set', () => {
    expect(masker(config).apply([], ['users'])).toEqual([])
  })
})

describe('ResultMasker — last4', () => {
  const m = masker({ tables: { cards: { columns: { masked: { number: 'last4' } } } } })

  it('keeps only the final four characters', () => {
    expect(m.apply([{ number: '4242424242424242' }], ['cards'])).toEqual([
      { number: '************4242' }
    ])
  })

  it('masks a short value entirely', () => {
    expect(m.apply([{ number: '42' }], ['cards'])).toEqual([{ number: '**' }])
  })

  it('stringifies non-string values', () => {
    expect(m.apply([{ number: 4242424242 }], ['cards'])).toEqual([{ number: '******4242' }])
  })

  it('leaves null alone', () => {
    expect(m.apply([{ number: null }], ['cards'])).toEqual([{ number: null }])
  })
})

describe('ResultMasker — partial', () => {
  const m = masker({ tables: { users: { columns: { masked: { email: 'partial' } } } } })

  it('keeps the domain of an email', () => {
    expect(m.apply([{ email: 'john@example.com' }], ['users'])).toEqual([
      { email: 'jo***@example.com' }
    ])
  })

  it('masks a short local part', () => {
    expect(m.apply([{ email: 'ab@example.com' }], ['users'])).toEqual([
      { email: '**@example.com' }
    ])
  })

  it('masks a plain string without an at sign', () => {
    const p = masker({ tables: { users: { columns: { masked: { name: 'partial' } } } } })
    expect(p.apply([{ name: 'Bahadir' }], ['users'])).toEqual([{ name: 'Ba***' }])
  })
})

describe('ResultMasker — combined', () => {
  it('strips and masks in the same pass', () => {
    const m = masker({
      tables: {
        users: { columns: { hidden: ['password'], masked: { email: 'partial' } } }
      }
    })
    const rows = [{ id: 1, email: 'john@example.com', password: 'secret' }]
    expect(m.apply(rows, ['users'])).toEqual([{ id: 1, email: 'jo***@example.com' }])
  })

  it('does not mutate the caller rows', () => {
    const m = masker({ tables: { users: { columns: { hidden: ['password'] } } } })
    const rows = [{ id: 1, password: 'secret' }]
    m.apply(rows, ['users'])
    expect(rows[0]).toEqual({ id: 1, password: 'secret' })
  })

  it('passes non-object rows through untouched', () => {
    const m = masker({ tables: { users: { columns: { hidden: ['password'] } } } })
    expect(m.apply([1, 'text', null], ['users'])).toEqual([1, 'text', null])
  })
})
