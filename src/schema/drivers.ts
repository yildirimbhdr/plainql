import { Dialect } from './types.js'

export interface DbConnection {
  dialect: Dialect
  execute(sql: string, params?: unknown[]): Promise<unknown[]>
  close(): Promise<void>
}

export function detectDialect(url: string): Dialect {
  if (url.startsWith('postgresql://') || url.startsWith('postgres://')) return Dialect.PostgreSQL
  if (url.startsWith('mysql://')) return Dialect.MySQL
  if (url.endsWith('.db') || url.endsWith('.sqlite') || url.startsWith('file:') || url === ':memory:') {
    return Dialect.SQLite
  }
  throw new Error(`PlainQL: unsupported database URL — expected postgres://, mysql://, file: or a .db/.sqlite path`)
}

export async function openConnection(url: string): Promise<DbConnection> {
  const dialect = detectDialect(url)
  switch (dialect) {
    case Dialect.PostgreSQL: return openPostgres(url)
    case Dialect.MySQL: return openMysql(url)
    case Dialect.SQLite: return openSqlite(url)
  }
}

async function openPostgres(url: string): Promise<DbConnection> {
  const { default: pg } = await load<typeof import('pg')>('pg', 'PostgreSQL')
  const client = new pg.Client({ connectionString: url })
  await client.connect()
  return {
    dialect: Dialect.PostgreSQL,
    async execute(sql, params = []) {
      const result = await client.query(sql, params)
      return result.rows
    },
    close: () => client.end()
  }
}

async function openMysql(url: string): Promise<DbConnection> {
  const { createConnection } = await load<typeof import('mysql2/promise')>('mysql2/promise', 'MySQL')
  const connection = await createConnection(url)
  return {
    dialect: Dialect.MySQL,
    async execute(sql, params = []) {
      const [rows] = await connection.query(sql, params)
      return Array.isArray(rows) ? rows : []
    },
    close: () => connection.end()
  }
}

async function openSqlite(url: string): Promise<DbConnection> {
  // better-sqlite3 is CommonJS: the constructor is the module's default export.
  const { default: Database } = await load<{ default: typeof import('better-sqlite3') }>('better-sqlite3', 'SQLite')
  const db = new Database(url.replace(/^file:/, ''))
  return {
    dialect: Dialect.SQLite,
    async execute(sql, params = []) {
      const statement = db.prepare(sql)
      if (statement.reader) return statement.all(...params)
      statement.run(...params)
      return []
    },
    async close() { db.close() }
  }
}

// Drivers are optional peer dependencies, loaded on demand.
async function load<T>(specifier: string, dialect: string): Promise<T> {
  try {
    return await import(specifier) as T
  } catch (error) {
    const code = (error as { code?: string }).code
    if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') {
      const pkg = specifier.split('/')[0]
      throw new Error(`PlainQL: the "${pkg}" package is required for ${dialect} — run: npm install ${pkg}`)
    }
    throw error
  }
}
