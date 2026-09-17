import type { PlainQLConfig } from './config/types.js'
import { SchemaIntrospector } from './schema/introspect.js'
export class PlainQL {
    private config: PlainQLConfig
    private role: string | undefined
    private schema: SchemaIntrospector
    private connected: boolean = false
  constructor(options: {
    config: PlainQLConfig
    role?: string
  }) {
    this.config = options.config
    this.role   = options.role
    this.schema = new SchemaIntrospector(this.config.connection);
  }

  public async connect(): Promise<void> {
    if (!this.connected) {
      await this.schema.connect()
      this.connected = true
    }
  }

  private ensureConnected(): void {
    if (!this.connected) {
      throw new Error('PlainQL: not connected — call connect() first')
    }
  }
}