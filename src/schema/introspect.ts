import { Dialect } from './types.js'
import type { SchemaContext, TableInfo, ColumnInfo, IndexInfo, RelationInfo } from './types.js'
import { detectDialect, openConnection, type DbConnection } from './drivers.js'

export interface ConnectionOptions {
    url: string
    /** Reads (introspection, SELECT, EXPLAIN) go here when set; writes always use `url`. */
    readOnlyUrl?: string
}

export interface ExecuteOptions {
    readOnly?: boolean
}

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

type MysqlTableRow = {
    name: string
    row_count: number | string | null
}

type MysqlColumnRow = {
    name: string
    type: string
    is_nullable: 'YES' | 'NO'
    column_key: string
    default_value: string | null
}

type MysqlIndexRow = {
    index_name: string
    non_unique: 0 | 1
    seq: number
    column_name: string
}

type MysqlForeignKeyRow = {
    from_table: string
    from_column: string
    to_table: string
    to_column: string
}

type PostgresTableRow = { name: string; row_count: string | number }
type PostgresColumnRow = { name: string; type: string; nullable: boolean; default_value: string | null }
type PostgresIndexRow = { index_name: string; is_unique: boolean; is_primary: boolean; column_name: string; seq: number }
type PostgresForeignKeyRow = MysqlForeignKeyRow

export class SchemaIntrospector {

    private connection: ConnectionOptions
    private databaseType: Dialect

    private primary?: DbConnection
    private replica?: DbConnection

    private context?: SchemaContext

    constructor(connection: ConnectionOptions) {
        this.connection = connection
        this.databaseType = detectDialect(connection.url)
        if (connection.readOnlyUrl && detectDialect(connection.readOnlyUrl) !== this.databaseType) {
            throw new Error('PlainQL: connection.url and connection.readOnlyUrl must use the same database dialect')
        }
    }

    public async connect(): Promise<void> {
        if (this.primary) return
        this.primary = await openConnection(this.connection.url)
        if (this.connection.readOnlyUrl) {
            this.replica = await openConnection(this.connection.readOnlyUrl)
        }
        await this.refresh()
    }

    public async disconnect(): Promise<void> {
        await this.replica?.close()
        await this.primary?.close()
        this.replica = undefined
        this.primary = undefined
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

    public get dialect(): Dialect {
        return this.databaseType
    }

    public getContext(): SchemaContext {
        if (!this.context) throw new Error('SchemaIntrospector: not connected — call connect() first')
        return this.context
    }

    public async execute(sql: string, params: unknown[] = [], options: ExecuteOptions = {}): Promise<unknown[]> {
        return this.pick(options.readOnly ?? false).execute(sql, params)
    }

    public async explain(sql: string): Promise<unknown[]> {
        const prefix = this.databaseType === Dialect.PostgreSQL ? 'EXPLAIN (FORMAT JSON) '
            : this.databaseType === Dialect.MySQL ? 'EXPLAIN FORMAT=JSON '
            : 'EXPLAIN QUERY PLAN '
        return this.pick(true).execute(prefix + sql)
    }

    private pick(readOnly: boolean): DbConnection {
        const connection = readOnly ? (this.replica ?? this.primary) : this.primary
        if (!connection) throw new Error('SchemaIntrospector: not connected — call connect() first')
        return connection
    }

    private read(sql: string, params: unknown[] = []): Promise<unknown[]> {
        return this.execute(sql, params, { readOnly: true })
    }

    private async fetchTables(): Promise<TableInfo[]> {
        if (this.databaseType === Dialect.SQLite) return this.fetchSqliteTables()
        if (this.databaseType === Dialect.MySQL) return this.fetchMysqlTables()
        return this.fetchPostgresTables()
    }

    private async fetchRelations(tables: TableInfo[]): Promise<RelationInfo[]> {
        if (this.databaseType === Dialect.SQLite) return this.fetchSqliteRelations(tables)
        if (this.databaseType === Dialect.MySQL) return this.fetchMysqlRelations()
        return this.fetchPostgresRelations()
    }

    private async fetchSqliteTables(): Promise<TableInfo[]> {
        const rows = await this.read(
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
        const rows = await this.read(
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
        const rows = await this.read(
            `PRAGMA index_list("${tableName}")`
        ) as SqlitePragmaIndex[]

        const indexes: IndexInfo[] = []
        for (const row of rows) {
            const columnRows = await this.read(
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
        const [row] = await this.read(
            `SELECT COUNT(*) AS count FROM "${tableName}"`
        ) as { count: number }[]
        return row?.count ?? 0
    }

    private async fetchSqliteRelations(tables: TableInfo[]): Promise<RelationInfo[]> {
        const relations: RelationInfo[] = []
        for (const table of tables) {
            const rows = await this.read(
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

    private async fetchMysqlTables(): Promise<TableInfo[]> {
        const rows = await this.read(
            `SELECT TABLE_NAME AS name, TABLE_ROWS AS row_count
             FROM information_schema.TABLES
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'
             ORDER BY TABLE_NAME`
        ) as MysqlTableRow[]

        const tables: TableInfo[] = []
        for (const row of rows) {
            const columns = await this.fetchMysqlColumns(row.name)
            const indexes = await this.fetchMysqlIndexes(row.name)
            tables.push({ name: row.name, columns, indexes, rowCount: Number(row.row_count ?? 0) })
        }
        return tables
    }

    private async fetchMysqlColumns(tableName: string): Promise<ColumnInfo[]> {
        const rows = await this.read(
            `SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE AS is_nullable,
                    COLUMN_KEY AS column_key, COLUMN_DEFAULT AS default_value
             FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
             ORDER BY ORDINAL_POSITION`,
            [tableName]
        ) as MysqlColumnRow[]

        const columns: ColumnInfo[] = []
        for (const row of rows) {
            const isPrimary = row.column_key === 'PRI'
            columns.push({
                name: row.name,
                type: row.type,
                nullable: row.is_nullable === 'YES',
                isPrimary,
                isUnique: isPrimary || row.column_key === 'UNI',
                defaultValue: row.default_value,
            })
        }
        return columns
    }

    private async fetchMysqlIndexes(tableName: string): Promise<IndexInfo[]> {
        const rows = await this.read(
            `SELECT INDEX_NAME AS index_name, NON_UNIQUE AS non_unique,
                    SEQ_IN_INDEX AS seq, COLUMN_NAME AS column_name
             FROM information_schema.STATISTICS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
             ORDER BY INDEX_NAME, SEQ_IN_INDEX`,
            [tableName]
        ) as MysqlIndexRow[]

        const byName = new Map<string, IndexInfo>()
        for (const row of rows) {
            let index = byName.get(row.index_name)
            if (!index) {
                index = { name: row.index_name, columns: [], isUnique: Number(row.non_unique) === 0 }
                byName.set(row.index_name, index)
            }
            index.columns.push(row.column_name)
        }
        return [...byName.values()]
    }

    private async fetchMysqlRelations(): Promise<RelationInfo[]> {
        const rows = await this.read(
            `SELECT TABLE_NAME AS from_table, COLUMN_NAME AS from_column,
                    REFERENCED_TABLE_NAME AS to_table, REFERENCED_COLUMN_NAME AS to_column
             FROM information_schema.KEY_COLUMN_USAGE
             WHERE TABLE_SCHEMA = DATABASE() AND REFERENCED_TABLE_NAME IS NOT NULL
             ORDER BY TABLE_NAME, CONSTRAINT_NAME, ORDINAL_POSITION`
        ) as MysqlForeignKeyRow[]

        return rows.map((row) => ({
            fromTable: row.from_table,
            fromColumn: row.from_column,
            toTable: row.to_table,
            toColumn: row.to_column,
        }))
    }

    private async fetchPostgresTables(): Promise<TableInfo[]> {
        const rows = await this.read(
            `SELECT c.relname AS name, c.reltuples::bigint AS row_count
             FROM pg_class c
             JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
             ORDER BY c.relname`
        ) as PostgresTableRow[]

        const tables: TableInfo[] = []
        for (const row of rows) {
            const columns = await this.fetchPostgresColumns(row.name)
            const indexes = await this.fetchPostgresIndexes(row.name)

            const primary = new Set(indexes.filter((i) => i.isPrimary).flatMap((i) => i.columns))
            const unique = new Set(
                indexes.filter((i) => i.isUnique && i.columns.length === 1).map((i) => i.columns[0])
            )
            for (const column of columns) {
                column.isPrimary = primary.has(column.name)
                column.isUnique = unique.has(column.name)
            }

            // reltuples is -1 on tables never analysed; treat that as unknown.
            const rowCount = Number(row.row_count)
            tables.push({
                name: row.name,
                columns,
                indexes: indexes.map(({ name, columns, isUnique }) => ({ name, columns, isUnique })),
                ...(rowCount >= 0 ? { rowCount } : {})
            })
        }
        return tables
    }

    private async fetchPostgresColumns(tableName: string): Promise<ColumnInfo[]> {
        const rows = await this.read(
            `SELECT a.attname AS name,
                    format_type(a.atttypid, a.atttypmod) AS type,
                    NOT a.attnotnull AS nullable,
                    pg_get_expr(d.adbin, d.adrelid) AS default_value
             FROM pg_attribute a
             JOIN pg_class c ON c.oid = a.attrelid
             JOIN pg_namespace n ON n.oid = c.relnamespace
             LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
             WHERE n.nspname = 'public' AND c.relname = $1 AND a.attnum > 0 AND NOT a.attisdropped
             ORDER BY a.attnum`,
            [tableName]
        ) as PostgresColumnRow[]

        return rows.map((row) => ({
            name: row.name,
            type: row.type,
            nullable: row.nullable,
            isPrimary: false,
            isUnique: false,
            defaultValue: row.default_value,
        }))
    }

    private async fetchPostgresIndexes(tableName: string): Promise<Array<IndexInfo & { isPrimary: boolean }>> {
        const rows = await this.read(
            `SELECT i.relname AS index_name, ix.indisunique AS is_unique, ix.indisprimary AS is_primary,
                    a.attname AS column_name, k.ord AS seq
             FROM pg_index ix
             JOIN pg_class t ON t.oid = ix.indrelid
             JOIN pg_namespace n ON n.oid = t.relnamespace
             JOIN pg_class i ON i.oid = ix.indexrelid
             JOIN LATERAL unnest(ix.indkey) WITH ORDINALITY AS k(attnum, ord) ON true
             JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
             WHERE n.nspname = 'public' AND t.relname = $1
             ORDER BY i.relname, k.ord`,
            [tableName]
        ) as PostgresIndexRow[]

        const byName = new Map<string, IndexInfo & { isPrimary: boolean }>()
        for (const row of rows) {
            let index = byName.get(row.index_name)
            if (!index) {
                index = { name: row.index_name, columns: [], isUnique: row.is_unique, isPrimary: row.is_primary }
                byName.set(row.index_name, index)
            }
            index.columns.push(row.column_name)
        }
        return [...byName.values()]
    }

    private async fetchPostgresRelations(): Promise<RelationInfo[]> {
        const rows = await this.read(
            `SELECT c.conrelid::regclass::text AS from_table, a.attname AS from_column,
                    c.confrelid::regclass::text AS to_table, af.attname AS to_column
             FROM pg_constraint c
             JOIN pg_namespace n ON n.oid = c.connamespace
             JOIN LATERAL unnest(c.conkey, c.confkey) WITH ORDINALITY AS k(attnum, fattnum, ord) ON true
             JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
             JOIN pg_attribute af ON af.attrelid = c.confrelid AND af.attnum = k.fattnum
             WHERE c.contype = 'f' AND n.nspname = 'public'
             ORDER BY 1, c.conname, k.ord`
        ) as PostgresForeignKeyRow[]

        return rows.map((row) => ({
            fromTable: this.unquote(row.from_table),
            fromColumn: row.from_column,
            toTable: this.unquote(row.to_table),
            toColumn: row.to_column,
        }))
    }

    // regclass quotes names that need it; the schema uses bare names.
    private unquote(name: string): string {
        return name.replace(/^"(.*)"$/, '$1').replace(/^public\./, '')
    }
}
