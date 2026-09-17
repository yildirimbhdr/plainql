import Database from "better-sqlite3";
import pg from "pg";
import { createConnection } from 'mysql2/promise'
import type { Connection as MySQLConnection } from 'mysql2/promise'
import { DatabaseType } from "./types";

export class SchemaIntrospector {

    private connectionUrl: string;
    private databaseType: DatabaseType;

    private pgClient?: pg.Client
    private mysqlConn?: MySQLConnection
    private sqliteDb?: Database.Database

    
    constructor(private connection: { url: string; readonlyUrl?: string }) {
        const url = connection.readonlyUrl || connection.url;
        this.connectionUrl = url;
        this.databaseType = this.detectDatabaseType(url);
    }

    private detectDatabaseType(url: string): DatabaseType {
        if (url.startsWith('postgresql://') || url.startsWith('postgres://')) return DatabaseType.PostgreSQL;
        if (url.startsWith('mysql://'))      return DatabaseType.MySQL;
        if (url.endsWith('.db') || url.startsWith('file:') || url === ':memory:') return DatabaseType.SQLite;
        throw new Error(`Unsupported database URL: ${url}`)
    }

    private async connect(): Promise<void> {
        if (this.databaseType === DatabaseType.PostgreSQL) {
        this.pgClient = new pg.Client({ connectionString: this.connectionUrl })
        await this.pgClient.connect()
        }

        if (this.databaseType === DatabaseType.MySQL) {
            this.mysqlConn = await createConnection(this.connectionUrl)
        }

        if (this.databaseType === DatabaseType.SQLite) {
            this.sqliteDb = new Database(this.connectionUrl.replace('file:', ''))
        }
    }

}