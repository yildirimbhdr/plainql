import { beforeAll, describe, expect, it } from 'vitest'
import { SchemaIntrospector } from './introspect.js'
import { Dialect } from './types.js'
import type { SchemaContext, TableInfo } from './types.js'

const SCHEMA = [
    `CREATE TABLE users (
        id INTEGER PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        first_name TEXT,
        last_name TEXT,
        active INTEGER DEFAULT 1,
        UNIQUE (first_name, last_name)
    )`,
    `CREATE TABLE orders (
        id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id),
        approved_by INTEGER REFERENCES users,
        total REAL
    )`,
    `CREATE INDEX idx_orders_user_id ON orders(user_id)`,
    `CREATE INDEX idx_orders_user_total ON orders(user_id, total)`,
    `INSERT INTO users (email) VALUES ('a@example.com'), ('b@example.com'), ('c@example.com')`,
    `INSERT INTO orders (user_id, total) VALUES (1, 10.5)`,
]

function table(ctx: SchemaContext, name: string): TableInfo {
    const found = ctx.tables.find((t) => t.name === name)
    if (!found) throw new Error(`table ${name} not introspected`)
    return found
}

describe('SchemaIntrospector (SQLite :memory:)', () => {
    let introspector: SchemaIntrospector
    let ctx: SchemaContext

    beforeAll(async () => {
        introspector = new SchemaIntrospector({ url: ':memory:' })
        await introspector.connect()
        for (const sql of SCHEMA) await introspector.execute(sql)
        await introspector.refresh()
        ctx = introspector.getContext()
    })

    describe('lifecycle', () => {
        it('throws when getContext() is called before connect()', () => {
            const fresh = new SchemaIntrospector({ url: ':memory:' })
            expect(() => fresh.getContext()).toThrow(/connect\(\)/)
        })

        it('throws when execute() is called before connect()', async () => {
            const fresh = new SchemaIntrospector({ url: ':memory:' })
            await expect(fresh.execute('SELECT 1')).rejects.toThrow(/connect\(\)/)
        })

        it('detects the SQLite dialect', () => {
            expect(ctx.dialect).toBe(Dialect.SQLite)
        })

        it('rejects unsupported URLs', () => {
            expect(() => new SchemaIntrospector({ url: 'mongodb://x' })).toThrow(/unsupported database URL/)
        })

        it('treats .db, .sqlite, file: and :memory: URLs as SQLite', async () => {
            for (const url of ['app.db', 'app.sqlite', 'file::memory:', ':memory:']) {
                const s = new SchemaIntrospector({ url })
                if (url.includes(':memory:')) {
                    await s.connect()
                    expect(s.getContext().dialect).toBe(Dialect.SQLite)
                    await s.disconnect()
                }
            }
        })

        it('disconnect() closes the connection and clears the schema', async () => {
            const s = new SchemaIntrospector({ url: ':memory:' })
            await s.connect()
            await s.disconnect()
            expect(() => s.getContext()).toThrow(/connect\(\)/)
            await expect(s.execute('SELECT 1')).rejects.toThrow(/connect\(\)/)
            await expect(s.disconnect()).resolves.toBeUndefined()
        })
    })

    describe('tables', () => {
        it('lists user tables and skips sqlite_* internals', () => {
            expect(ctx.tables.map((t) => t.name).sort()).toEqual(['orders', 'users'])
        })

        it('reports row counts', () => {
            expect(table(ctx, 'users').rowCount).toBe(3)
            expect(table(ctx, 'orders').rowCount).toBe(1)
        })
    })

    describe('columns', () => {
        it('keeps declaration order and types', () => {
            const names = table(ctx, 'users').columns.map((c) => c.name)
            expect(names).toEqual(['id', 'email', 'first_name', 'last_name', 'active'])
            expect(table(ctx, 'orders').columns.find((c) => c.name === 'total')?.type).toBe('REAL')
        })

        it('marks the primary key as primary, unique and non-nullable', () => {
            const id = table(ctx, 'users').columns.find((c) => c.name === 'id')
            expect(id).toMatchObject({ isPrimary: true, isUnique: true, nullable: false })
        })

        it('derives isUnique from single-column UNIQUE constraints', () => {
            const email = table(ctx, 'users').columns.find((c) => c.name === 'email')
            expect(email).toMatchObject({ isPrimary: false, isUnique: true, nullable: false })
        })

        it('does not mark columns of a composite UNIQUE as unique', () => {
            const cols = table(ctx, 'users').columns
            expect(cols.find((c) => c.name === 'first_name')?.isUnique).toBe(false)
            expect(cols.find((c) => c.name === 'last_name')?.isUnique).toBe(false)
        })

        it('reports nullability and default values', () => {
            const cols = table(ctx, 'users').columns
            expect(cols.find((c) => c.name === 'first_name')).toMatchObject({ nullable: true, defaultValue: null })
            expect(cols.find((c) => c.name === 'active')).toMatchObject({ nullable: true, defaultValue: '1' })
        })
    })

    describe('indexes', () => {
        it('includes SQLite auto-indexes created by UNIQUE constraints', () => {
            const idx = table(ctx, 'users').indexes
            expect(idx.some((i) => i.isUnique && i.columns.length === 1 && i.columns[0] === 'email')).toBe(true)
            expect(idx.some((i) => i.isUnique && i.columns.join(',') === 'first_name,last_name')).toBe(true)
        })

        it('includes explicit indexes with correct uniqueness', () => {
            const idx = table(ctx, 'orders').indexes.find((i) => i.name === 'idx_orders_user_id')
            expect(idx).toEqual({ name: 'idx_orders_user_id', columns: ['user_id'], isUnique: false })
        })

        it('preserves column order in composite indexes', () => {
            const idx = table(ctx, 'orders').indexes.find((i) => i.name === 'idx_orders_user_total')
            expect(idx?.columns).toEqual(['user_id', 'total'])
        })
    })

    describe('relations', () => {
        it('resolves foreign keys with an explicit target column', () => {
            expect(ctx.relations).toContainEqual({
                fromTable: 'orders', fromColumn: 'user_id', toTable: 'users', toColumn: 'id',
            })
        })

        it('falls back to the target primary key when the FK omits the column', () => {
            expect(ctx.relations).toContainEqual({
                fromTable: 'orders', fromColumn: 'approved_by', toTable: 'users', toColumn: 'id',
            })
        })

        it('reports nothing for tables without foreign keys', () => {
            expect(ctx.relations.filter((r) => r.fromTable === 'users')).toEqual([])
        })
    })

    describe('execute', () => {
        it('returns rows for reads and an empty array for writes', async () => {
            expect(await introspector.execute('INSERT INTO users (email) VALUES (?)', ['d@example.com'])).toEqual([])
            const rows = await introspector.execute('SELECT email FROM users WHERE email = ?', ['d@example.com'])
            expect(rows).toEqual([{ email: 'd@example.com' }])
        })

        it('refresh() picks up new tables and row counts', async () => {
            await introspector.execute('CREATE TABLE tags (id INTEGER PRIMARY KEY, label TEXT)')
            await introspector.refresh()
            const tags = table(introspector.getContext(), 'tags')
            expect(tags.columns.map((c) => c.name)).toEqual(['id', 'label'])
            expect(table(introspector.getContext(), 'users').rowCount).toBe(4)
        })
    })
})

describe('SchemaIntrospector — read/write routing', () => {
    it('sends reads to the replica and writes to the primary', async () => {
        const { mkdtempSync } = await import('node:fs')
        const { tmpdir } = await import('node:os')
        const { join } = await import('node:path')
        const dir = mkdtempSync(join(tmpdir(), 'plainql-'))
        const primary = join(dir, 'primary.db')
        const replica = join(dir, 'replica.db')

        const seed = new SchemaIntrospector({ url: replica })
        await seed.connect()
        await seed.execute('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)')
        await seed.execute("INSERT INTO t (v) VALUES ('from replica')")
        await seed.disconnect()

        const s = new SchemaIntrospector({ url: primary, readOnlyUrl: replica })
        await s.connect()
        // Introspection came from the replica: the primary has no tables yet.
        expect(s.getContext().tables.map((t) => t.name)).toEqual(['t'])
        await s.execute('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)')
        await s.execute("INSERT INTO t (v) VALUES ('from primary')")

        expect(await s.execute('SELECT v FROM t', [], { readOnly: true })).toEqual([{ v: 'from replica' }])
        expect(await s.execute('SELECT v FROM t')).toEqual([{ v: 'from primary' }])
        expect((await s.explain('SELECT v FROM t')).length).toBeGreaterThan(0)
        await s.disconnect()
    })

    it('refuses mismatched dialects between url and readOnlyUrl', () => {
        expect(() => new SchemaIntrospector({ url: ':memory:', readOnlyUrl: 'mysql://x' }))
            .toThrow(/same database dialect/)
    })
})
