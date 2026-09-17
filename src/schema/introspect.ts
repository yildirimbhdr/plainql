import Database from 'better-sqlite3'
import pg from 'pg'
import { createConnection } from 'mysql2/promise'
import type { Connection as MySQLConnection } from 'mysql2/promise'
import { Dialect } from './types.js'
import type { SchemaContext, TableInfo, ColumnInfo, IndexInfo, RelationInfo } from './types.js'



type SqlitePragmaColumn = {
    cid: number
    name: string
    type: string
    notnull: 0 | 1
    dflt_value: string | null
    pk: number
}

type SqlitePragmaIndex = {
    seq: number
    name: string
    unique: 0 | 1
    origin: 'c' | 'u' | 'pk'
    partial: 0 | 1
}

type SqlitePragmaIndexColumn = {
    seqno: number
    cid: number
    name: string
}

type SqlitePragmaForeignKey = {
    id: number
    seq: number
    table: string
    from: string
    to: string | null
}


export class SchemaIntrospector {

    // #region State

    private connectionUrl: string
    private databaseType: Dialect

    private pgClient?: pg.Client
    private mysqlConn?: MySQLConnection
    private sqliteDb?: Database.Database

    private context?: SchemaContext

    constructor(private connection: { url: string; readOnlyUrl?: string }) {
        const url = connection.readOnlyUrl || connection.url
        this.connectionUrl = url
        this.databaseType = this.detectDialect(url)
    }

    // #endregionx

    // #region Lifecycle

    public async connect(): Promise<void> {
        if (this.databaseType === Dialect.PostgreSQL) {
            this.pgClient = new pg.Client({ connectionString: this.connectionUrl })
            await this.pgClient.connect()
        }

        if (this.databaseType === Dialect.MySQL) {
            this.mysqlConn = await createConnection(this.connectionUrl)
        }

        if (this.databaseType === Dialect.SQLite) {
            this.sqliteDb = new Database(this.connectionUrl.replace('file:', ''))
        }

        await this.refresh()
    }

    public async disconnect(): Promise<void> {
        if (this.pgClient) {
            await this.pgClient.end()
            this.pgClient = undefined
        }
        if (this.mysqlConn) {
            await this.mysqlConn.end()
            this.mysqlConn = undefined
        }
        if (this.sqliteDb) {
            this.sqliteDb.close()
            this.sqliteDb = undefined
        }
        this.context = undefined
    }

    public async refresh(): Promise<void> {
        this.context = {
            dialect: this.databaseType,
            tables: await this.fetchTables(),
            relations: [],
        }
        this.context.relations = await this.fetchRelations(this.context.tables)
    }

    // #endregion

    // #region Public query surface

    public getContext(): SchemaContext {
        if (!this.context) throw new Error('SchemaIntrospector: not connected — call connect() first')
        return this.context
    }

    public async execute(sql: string, params: unknown[] = []): Promise<unknown[]> {
        if (this.pgClient) {
            const result = await this.pgClient.query(sql, params)
            return result.rows
        }

        if (this.mysqlConn) {
            const [rows] = await this.mysqlConn.query(sql, params)
            return Array.isArray(rows) ? rows : []
        }

        if (this.sqliteDb) {
            const stmt = this.sqliteDb.prepare(sql)
            if (stmt.reader) return stmt.all(...params)
            stmt.run(...params)
            return []
        }

        throw new Error('SchemaIntrospector: not connected — call connect() first')
    }

    // #endregion

    // #region Introspection (dialect dispatch)

    private async fetchTables(): Promise<TableInfo[]> {
        if (this.databaseType === Dialect.SQLite) return this.fetchSqliteTables()
        if (this.databaseType === Dialect.MySQL) return this.fetchMysqlTables()
        return this.fetchPostgresTables()
    }

    private async fetchRelations(tables: TableInfo[]): Promise<RelationInfo[]> {
        if (this.databaseType === Dialect.SQLite) return this.fetchSqliteRelations(tables)
        if (this.databaseType === Dialect.MySQL) return this.fetchMysqlRelations()
        return this.fetchPostgresqlRelations()
    }
    // #endregion

    // #region SQLite

    private async fetchSqliteTables(): Promise<TableInfo[]> {
        const rows = await this.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
        ) as { name: string }[]

        const tables: TableInfo[] = []
        for (const row of rows) {
            const columns = await this.fetchSqliteColumns(row.name)
            const indexes = await this.fetchSqliteIndexes(row.name)
            const rowCount = await this.fetchSqliteRowCount(row.name)

            const uniqueColumns = new Set(
                indexes.filter((i) => i.isUnique && i.columns.length === 1).map((i) => i.columns[0])
            )
            
            for (const column of columns) {
                if (uniqueColumns.has(column.name)) column.isUnique = true
            }

            tables.push({ name: row.name, columns, indexes, rowCount })
        }
        return tables
    }

    private async fetchSqliteColumns(tableName: string): Promise<ColumnInfo[]> {
        const rows = await this.execute(
            `PRAGMA table_info("${tableName}")`
        ) as SqlitePragmaColumn[]

        const columns: ColumnInfo[] = []
        for (const row of rows) {
            columns.push({
                name: row.name,
                type: row.type,
                nullable: row.notnull === 0 && row.pk === 0,
                isPrimary: row.pk > 0,
                isUnique: row.pk > 0,
                defaultValue: row.dflt_value,
            })
        }
        return columns
    }

    private async fetchSqliteIndexes(tableName: string): Promise<IndexInfo[]> {
        const rows = await this.execute(
            `PRAGMA index_list("${tableName}")`
        ) as SqlitePragmaIndex[]

        const indexes: IndexInfo[] = []
        for (const row of rows) {
            const columnRows = await this.execute(
                `PRAGMA index_info("${row.name}")`
            ) as SqlitePragmaIndexColumn[]

            indexes.push({
                name: row.name,
                columns: columnRows.map((c) => c.name),
                isUnique: row.unique === 1,
            })
        }
        return indexes
    }

    private async fetchSqliteRowCount(tableName: string): Promise<number> {
        const [row] = await this.execute(
            `SELECT COUNT(*) AS count FROM "${tableName}"`
        ) as { count: number }[]
        return row?.count ?? 0
    }

    private async fetchSqliteRelations(tables: TableInfo[]): Promise<RelationInfo[]> {
        const relations: RelationInfo[] = []
        for (const table of tables) {
            const rows = await this.execute(
                `PRAGMA foreign_key_list("${table.name}")`
            ) as SqlitePragmaForeignKey[]

            for (const row of rows) {
                const toColumn = row.to
                    ?? tables.find((t) => t.name === row.table)?.columns.find((c) => c.isPrimary)?.name
                if (!toColumn) continue

                relations.push({
                    fromTable: table.name,
                    fromColumn: row.from,
                    toTable: row.table,
                    toColumn,
                })
            }
        }
        return relations
    }
    // #endregion

    // #region MySQL

    private async fetchMysqlTables(): Promise<TableInfo[]> {
        throw new Error('SchemaIntrospector: MySQL introspection not implemented yet')
    }
    private async fetchMysqlRelations():Promise<RelationInfo[]>{
        throw new Error('SchemaIntrospector: MySQL introspection not implemented yet')
    }

    // #endregion

    // #region PostgreSQL

    private async fetchPostgresTables(): Promise<TableInfo[]> {
        throw new Error('SchemaIntrospector: PostgreSQL introspection not implemented yet')
    }

    private async fetchPostgresqlRelations(): Promise<RelationInfo[]> {
        throw new Error('SchemaIntrospector: PostgreSQL introspection not implemented yet')
    }

    // #endregion

    // #region Helpers

    private detectDialect(url: string): Dialect {
        if (url.startsWith('postgresql://') || url.startsWith('postgres://')) return Dialect.PostgreSQL
        if (url.startsWith('mysql://')) return Dialect.MySQL
        if (url.endsWith('.db') || url.endsWith('.sqlite') || url.startsWith('file:') || url === ':memory:') return Dialect.SQLite
        throw new Error(`Unsupported database URL: ${url}`)
    }

    // #endregion
}
