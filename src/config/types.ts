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
  ai: AIConfig
}

export interface TableRule {
  allow?: Operation[]
  deny?: Operation[]
  columns?: {
    hidden?: string[]
    readonly?: string[]
    writable?: string[]
    masked?: Record<string, 'last4' | 'partial'>
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
  cache?: {
    enabled: boolean
    ttl?: number
    storage?: 'file' | 'memory'
  }
}
