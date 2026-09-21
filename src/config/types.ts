export type Operation = 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE'

export interface PlainQLConfig {
  connection: {
    url: string
    readOnlyUrl?: string
  }
  security?: {
    blockedOperations?: string[]
    requireWhereClause?: boolean
    dryRun?: boolean
    onViolation?: 'throw' | 'warn' | 'ignore'
  }
  tables?: Record<string, TableRule>
  roles?: Record<string, RoleRule>
  queries?: Record<string, string>
  /** Domain knowledge the schema cannot express; sent with every request. */
  context?: string
  ai: AIConfig
}

export interface TableRule {
  allow?: Operation[]
  deny?: Operation[]
  /** What the table holds and how it is used — shown to the model next to its columns. */
  description?: string
  columns?: {
    hidden?: string[]
    readonly?: string[]
    writable?: string[]
    masked?: Record<string, 'last4' | 'partial'>
    /** Per-column notes for the model: enum values, JSON shape, units. Never emitted for hidden columns. */
    hints?: Record<string, string>
  }
  maxRows?: number
  requireWhere?: Operation[]
  deletePolicy?: { requireCondition: string }
}

export interface RoleRule {
  extends?: string
  globalAllow?: Operation[]
  tables?: Record<string, TableRule>
}

export interface AIConfig {
  provider: 'anthropic' | 'openai' | 'ollama'
  apiKey?: string
  model?: string
  /** Provider-side cache of the schema prefix. '5m' (default) or '1h' for bursty traffic. */
  promptCacheTtl?: '5m' | '1h'
  cache?: {
    /** Default: true. */
    enabled?: boolean
    /** Seconds a cached SQL stays valid. Default: forever, until the schema changes. */
    ttl?: number
    /** Default: 'file' (`.plainql/cache.json`). */
    storage?: 'file' | 'memory'
    /** Directory for the cache file. Default: `.plainql`. */
    dir?: string
    /** Reuse SQL for prompts that share the same words (layer 3). Default: true. */
    intent?: boolean
  }
}
