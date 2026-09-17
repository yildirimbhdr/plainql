export enum DatabaseType {
    PostgreSQL = 'postgresql',
    MySQL      = 'mysql',
    SQLite     = 'sqlite'
}

export interface ColumnInfo {
    name: string
    type: string
    nullable: boolean
    isPrimary: boolean
    isUnique: boolean
    defaultValue: string | null
}

export interface IndexInfo {
    name: string
    columns: string[]
    isUnique: boolean
}

export interface TableInfo {
    name: string
    columns: ColumnInfo[]
    indexes: IndexInfo[]
    rowCount?: number
}

export interface RelationInfo {
    fromTable: string
    fromColumn: string
    toTable: string
    toColumn: string
}

export interface SchemaContext {
    tables: TableInfo[]
    relations: RelationInfo[]
    dialect: DatabaseType
}