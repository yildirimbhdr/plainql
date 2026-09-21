import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CacheManager, type CacheEntry } from './manager.js'

const entry = (sql: string, over: Partial<CacheEntry> = {}): CacheEntry => ({
  sql,
  tables: ['users'],
  tokens: 1000,
  createdAt: Date.now(),
  ...over
})

const dirs: string[] = []
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'plainql-cache-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('CacheManager.fingerprint', () => {
  it('ignores filler words, case, punctuation and order', () => {
    expect(CacheManager.fingerprint('Show me the active users!'))
      .toBe(CacheManager.fingerprint('active users'))
    expect(CacheManager.fingerprint('users, active')).toBe('active users')
  })

  it('keeps words that change the query', () => {
    const base = CacheManager.fingerprint('orders today')
    expect(CacheManager.fingerprint('orders yesterday')).not.toBe(base)
    expect(CacheManager.fingerprint('orders not today')).not.toBe(base)
    expect(CacheManager.fingerprint('how many orders today')).not.toBe(base)
    expect(CacheManager.fingerprint('last 10 orders')).not.toBe(CacheManager.fingerprint('last 20 orders'))
  })

  it('handles non-ASCII words', () => {
    expect(CacheManager.fingerprint('Aktif kullanıcıları göster')).toBe('aktif göster kullanıcıları')
  })
})

describe('CacheManager — memory', () => {
  const manager = () => new CacheManager({ storage: 'memory' }, { schemaHash: 'abc' })

  it('misses on an empty cache and counts it', () => {
    const cache = manager()
    expect(cache.lookup('anything')).toBeUndefined()
    expect(cache.getStats()).toEqual({ hits: 0, misses: 1, tokensSaved: 0 })
  })

  it('hits the exact prompt first, then the intent fingerprint', async () => {
    const cache = manager()
    await cache.store('List active users', entry('SELECT 1'))

    expect(cache.lookup('List active users')).toMatchObject({ layer: 'exact', entry: { sql: 'SELECT 1' } })
    expect(cache.lookup('active users, please')).toMatchObject({ layer: 'intent', entry: { sql: 'SELECT 1' } })
    expect(cache.getStats()).toEqual({ hits: 2, misses: 0, tokensSaved: 2000 })
  })

  it('can run without intent matching', async () => {
    const cache = new CacheManager({ storage: 'memory', intent: false }, { schemaHash: 'abc' })
    await cache.store('List active users', entry('SELECT 1'))
    expect(cache.lookup('active users')).toBeUndefined()
    expect(cache.lookup('List active users')?.layer).toBe('exact')
  })

  it('keeps static queries apart from prompts and never counts them', async () => {
    const cache = manager()
    await cache.storeStatic('activeUsers', entry('SELECT 2'))
    expect(cache.getStatic('activeUsers')?.sql).toBe('SELECT 2')
    expect(cache.lookup('activeUsers')).toBeUndefined()
    expect(cache.getStats()).toEqual({ hits: 0, misses: 1, tokensSaved: 0 })
  })

  it('expires entries after the ttl', async () => {
    const cache = new CacheManager({ storage: 'memory', ttl: 60 }, { schemaHash: 'abc' })
    await cache.store('old', entry('SELECT 1', { createdAt: Date.now() - 61_000 }))
    await cache.store('new', entry('SELECT 2'))
    expect(cache.lookup('old')).toBeUndefined()
    expect(cache.lookup('new')?.entry.sql).toBe('SELECT 2')
  })

  it('does nothing when disabled', async () => {
    const cache = new CacheManager({ enabled: false, storage: 'memory' }, { schemaHash: 'abc' })
    await cache.store('x', entry('SELECT 1'))
    expect(cache.lookup('x')).toBeUndefined()
    expect(cache.getStats()).toEqual({ hits: 0, misses: 0, tokensSaved: 0 })
  })
})

describe('CacheManager — file', () => {
  it('persists to dir/cache.json and reloads in a new instance', async () => {
    const dir = tempDir()
    const first = new CacheManager({ dir }, { schemaHash: 'abc', role: 'analyst' })
    await first.load()
    await first.store('List users', entry('SELECT 1'))
    await first.storeStatic('all', entry('SELECT 2'))

    const written = JSON.parse(readFileSync(join(dir, 'cache.json'), 'utf8'))
    expect(written).toMatchObject({ version: 1, schemaHash: 'abc' })
    expect(written.roles.analyst.exact['List users'].sql).toBe('SELECT 1')

    const second = new CacheManager({ dir }, { schemaHash: 'abc', role: 'analyst' })
    await second.load()
    expect(second.lookup('List users')?.entry.sql).toBe('SELECT 1')
    expect(second.getStatic('all')?.sql).toBe('SELECT 2')
  })

  it('scopes entries by role', async () => {
    const dir = tempDir()
    const analyst = new CacheManager({ dir }, { schemaHash: 'abc', role: 'analyst' })
    await analyst.load()
    await analyst.store('List users', entry('SELECT 1'))

    const support = new CacheManager({ dir }, { schemaHash: 'abc', role: 'support' })
    await support.load()
    expect(support.lookup('List users')).toBeUndefined()
  })

  it('discards the file when the schema hash changed', async () => {
    const dir = tempDir()
    const before = new CacheManager({ dir }, { schemaHash: 'v1' })
    await before.load()
    await before.store('List users', entry('SELECT 1'))

    const after = new CacheManager({ dir }, { schemaHash: 'v2' })
    await after.load()
    expect(after.lookup('List users')).toBeUndefined()
  })

  it('survives a corrupt or foreign cache file', async () => {
    const dir = tempDir()
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'cache.json'), '{not json')
    const cache = new CacheManager({ dir }, { schemaHash: 'abc' })
    await expect(cache.load()).resolves.toBeUndefined()
    await cache.store('x', entry('SELECT 1'))
    expect(cache.lookup('x')?.entry.sql).toBe('SELECT 1')
  })

  it('drops expired entries from disk', async () => {
    const dir = tempDir()
    const cache = new CacheManager({ dir, ttl: 60 }, { schemaHash: 'abc' })
    await cache.load()
    await cache.store('old', entry('SELECT 1', { createdAt: Date.now() - 120_000 }))
    await cache.store('new', entry('SELECT 2'))
    const written = JSON.parse(readFileSync(join(dir, 'cache.json'), 'utf8'))
    expect(Object.keys(written.roles[''].exact)).toEqual(['new'])
  })
})

describe('CacheManager.hashSchema', () => {
  it('changes when a column or type changes, not when nothing does', () => {
    const a = CacheManager.hashSchema([{ name: 'users', columns: [{ name: 'id', type: 'int' }] }])
    expect(CacheManager.hashSchema([{ name: 'users', columns: [{ name: 'id', type: 'int' }] }])).toBe(a)
    expect(CacheManager.hashSchema([{ name: 'users', columns: [{ name: 'id', type: 'bigint' }] }])).not.toBe(a)
    expect(CacheManager.hashSchema([{ name: 'users', columns: [{ name: 'id', type: 'int' }, { name: 'x', type: 'int' }] }])).not.toBe(a)
  })
})
