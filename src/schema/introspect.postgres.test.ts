import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SchemaIntrospector } from './introspect.js'
import { Dialect } from './types.js'
import type { SchemaContext, TableInfo } from './types.js'

/**
 * Runs only when POSTGRES_URL is set, e.g.
 *   POSTGRES_URL=postgres://postgres:pg@localhost:55432/plainql_test npx vitest run
 * The database must exist; every table is dropped and recreated.
 */
const POSTGRES_URL = process.env.POSTGRES_URL

const SCHEMA = [
    `DROP TABLE IF EXISTS orders`,
    `DROP TABLE IF EXISTS users`,
    `CREATE TABLE users (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) NOT NULL UNIQUE,
        first_name VARCHAR(100),
        last_name VARCHAR(100),
        active SMALLINT DEFAULT 1,
        CONSTRAINT uq_users_name UNIQUE (first_name, last_name)
    )`,
    `CREATE TABLE orders (
        id SERIAL PRIMARY KEY,
        user_id INT NOT NULL REFERENCES users(id),
        approved_by INT REFERENCES users(id),
        total NUMERIC(10,2)
    )`,
    `CREATE INDEX idx_orders_user_total ON orders(user_id, total)`,
    `INSERT INTO users (email) VALUES ('a@example.com'), ('b@example.com'), ('c@example.com')`,
    `INSERT INTO orders (user_id, total) VALUES (1, 10.5)`,
    `ANALYZE users`,
    `ANALYZE orders`,
]

function table(ctx: SchemaContext, name: string): TableInfo {
    const found = ctx.tables.find((t) => t.name === name)
    if (!found) throw new Error(`table ${name} not introspected`)
    return found
}

describe.skipIf(!POSTGRES_URL)('SchemaIntrospector (PostgreSQL)', () => {
    let introspector: SchemaIntrospector
    let ctx: SchemaContext

    beforeAll(async () => {
        introspector = new SchemaIntrospector({ url: POSTGRES_URL! })
        await introspector.connect()
        for (const sql of SCHEMA) await introspector.execute(sql)
        await introspector.refresh()
        ctx = introspector.getContext()
    })

    afterAll(async () => {
        await introspector?.disconnect()
    })

    it('detects the PostgreSQL dialect', () => {
        expect(ctx.dialect).toBe(Dialect.PostgreSQL)
    })

    it('lists only tables from the public schema', () => {
        expect(ctx.tables.map((t) => t.name).sort()).toEqual(['orders', 'users'])
    })

    it('reports (estimated) row counts as numbers after ANALYZE', () => {
        expect(table(ctx, 'users').rowCount).toBe(3)
        expect(table(ctx, 'orders').rowCount).toBe(1)
    })

    it('keeps declaration order and full column types', () => {
        const cols = table(ctx, 'users').columns
        expect(cols.map((c) => c.name)).toEqual(['id', 'email', 'first_name', 'last_name', 'active'])
        expect(cols.find((c) => c.name === 'email')?.type).toBe('character varying(255)')
        expect(table(ctx, 'orders').columns.find((c) => c.name === 'total')?.type).toBe('numeric(10,2)')
    })

    it('marks the primary key as primary, unique and non-nullable', () => {
        expect(table(ctx, 'users').columns.find((c) => c.name === 'id'))
            .toMatchObject({ isPrimary: true, isUnique: true, nullable: false })
    })

    it('marks UNIQUE columns and leaves composite-unique columns alone', () => {
        const cols = table(ctx, 'users').columns
        expect(cols.find((c) => c.name === 'email')).toMatchObject({ isPrimary: false, isUnique: true })
        expect(cols.find((c) => c.name === 'first_name')?.isUnique).toBe(false)
        expect(cols.find((c) => c.name === 'last_name')?.isUnique).toBe(false)
    })

    it('reports nullability and default values', () => {
        const cols = table(ctx, 'users').columns
        expect(cols.find((c) => c.name === 'first_name')).toMatchObject({ nullable: true, defaultValue: null })
        expect(cols.find((c) => c.name === 'active')).toMatchObject({ nullable: true, defaultValue: '1' })
        expect(cols.find((c) => c.name === 'id')?.defaultValue).toMatch(/nextval/)
    })

    it('includes primary, unique and plain indexes with correct uniqueness', () => {
        const idx = table(ctx, 'users').indexes
        expect(idx.find((i) => i.name === 'users_pkey')).toEqual({ name: 'users_pkey', columns: ['id'], isUnique: true })
        expect(idx.find((i) => i.name === 'users_email_key')).toEqual({ name: 'users_email_key', columns: ['email'], isUnique: true })
        expect(idx.find((i) => i.name === 'uq_users_name'))
            .toEqual({ name: 'uq_users_name', columns: ['first_name', 'last_name'], isUnique: true })
    })

    it('groups composite index rows and preserves column order', () => {
        const idx = table(ctx, 'orders').indexes.find((i) => i.name === 'idx_orders_user_total')
        expect(idx).toEqual({ name: 'idx_orders_user_total', columns: ['user_id', 'total'], isUnique: false })
    })

    it('resolves foreign keys', () => {
        expect(ctx.relations).toContainEqual({ fromTable: 'orders', fromColumn: 'user_id', toTable: 'users', toColumn: 'id' })
        expect(ctx.relations).toContainEqual({ fromTable: 'orders', fromColumn: 'approved_by', toTable: 'users', toColumn: 'id' })
        expect(ctx.relations.filter((r) => r.fromTable === 'users')).toEqual([])
    })

    it('execute() supports $n placeholders and returns [] for writes', async () => {
        expect(await introspector.execute('INSERT INTO users (email) VALUES ($1)', ['d@example.com'])).toEqual([])
        expect(await introspector.execute('SELECT email FROM users WHERE email = $1', ['d@example.com']))
            .toEqual([{ email: 'd@example.com' }])
    })

    it('explain() returns a JSON plan without running the statement', async () => {
        const plan = await introspector.explain('SELECT email FROM users')
        expect(plan.length).toBe(1)
        expect(JSON.stringify(plan)).toContain('Plan')
    })
})
