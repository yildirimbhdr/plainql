import type { PlainQLConfig } from './config/types.ts'
import { SchemaIntrospector } from './schema/introspect.ts'
export class PlainQL {
    private config: PlainQLConfig
    private role: string | undefined
    private schema: SchemaIntrospector
  constructor(options: {
    config: PlainQLConfig
    role?: string
  }) {
    this.config = options.config
    this.role   = options.role
    this.schema = new SchemaIntrospector(this.config.connection);
  }
}