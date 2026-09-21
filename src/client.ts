import { AIBridge, type AIProvider } from './ai/bridge.js'
import type { PromptOptions } from './ai/prompt.js'
import { CacheManager, type CacheEntry, type CacheLayer, type CacheStats } from './cache/manager.js'
import type { Operation, PlainQLConfig } from './config/types.js'
import { SchemaIntrospector } from './schema/introspect.js'
import type { SchemaContext } from './schema/types.js'
import { ResultMasker } from './security/mask.js'
import { RuleSet } from './security/rules.js'
import { SecurityValidator, type ValidationResult } from './security/validator.js'
import { ViolationError, type ViolationLayer } from './security/violations.js'

export interface PlainQLOptions extends PromptOptions {
  config: PlainQLConfig
  role?: string
  aiProvider?: AIProvider
}

export type QuerySource = CacheLayer | 'ai'

export interface PreviewResult {
  sql: string
  blocked: boolean
  reason?: string
  layer?: ViolationLayer
  operation?: Operation
  tables: string[]
  warnings: string[]
}

export interface ExplainResult {
  sql: string
  plan: unknown[]
  warnings: string[]
}

export interface LastQuery {
  prompt: string
  sql: string
  operation: Operation
  tables: string[]
  source: QuerySource
  tokens: number
  executed: boolean
  warnings: string[]
}

const NOT_CONNECTED = 'PlainQL: call connect() before running queries'

export class PlainQL {
  private config: PlainQLConfig
  private role?: string
  private aiProvider?: AIProvider
  private promptOptions: PromptOptions
  private schema: SchemaIntrospector

  private rules?: RuleSet
  private validator?: SecurityValidator
  private masker?: ResultMasker
  private bridge?: AIBridge
  private cache?: CacheManager
  private lastQuery?: LastQuery

  constructor(options: PlainQLOptions) {
    const { config, role, aiProvider, ...promptOptions } = options
    this.config = config
    this.role = role
    this.aiProvider = aiProvider
    this.promptOptions = promptOptions
    this.schema = new SchemaIntrospector(config.connection)
  }

  public async connect(): Promise<void> {
    if (this.cache) return
    await this.schema.connect()
    const context = this.schema.getContext()

    this.rules = new RuleSet(this.config, this.role)
    this.validator = new SecurityValidator(this.config, context.dialect, this.role)
    this.masker = new ResultMasker(this.rules)
    this.bridge = new AIBridge(this.config.ai, this.rules, {
      ...this.promptOptions,
      ...(this.aiProvider ? { provider: this.aiProvider } : {})
    })

    const cache = new CacheManager(this.config.ai.cache ?? {}, {
      schemaHash: CacheManager.hashSchema(context.tables),
      role: this.role
    })
    await cache.load()
    this.cache = cache

    await this.resolveStaticQueries()
  }

  public async disconnect(): Promise<void> {
    await this.schema.disconnect()
    this.cache = undefined
  }

  public async get(prompt: string): Promise<unknown[]> {
    return this.read(prompt)
  }

  public async first(prompt: string): Promise<unknown | null> {
    const rows = await this.read(prompt)
    return rows[0] ?? null
  }

  public async count(prompt: string): Promise<number> {
    const rows = await this.read(prompt)
    if (rows.length === 1 && rows[0] !== null && typeof rows[0] === 'object') {
      const values = Object.values(rows[0] as Record<string, unknown>)
      if (values.length === 1) {
        const number = Number(values[0])
        if (Number.isFinite(number)) return number
      }
    }
    return rows.length
  }

  public async run(prompt: string): Promise<void> {
    const prepared = await this.prepare(prompt)
    if (prepared.result.operation === 'SELECT') {
      throw new Error(`PlainQL: run() executes writes only; "${prompt}" produced a SELECT — use get()`)
    }
    await this.execute(prepared, false)
  }

  public async query(name: string): Promise<unknown[]> {
    const { validator, cache } = this.ready()
    const entry = cache.getStatic(name)
    if (!entry) {
      throw new Error(`PlainQL: unknown static query "${name}" — add it to config.queries`)
    }
    const result = validator.validate(entry.sql)
    const prepared: Prepared = { prompt: name, result, source: 'static', tokens: 0 }
    return this.execute(prepared, result.operation === 'SELECT')
  }

  public async preview(prompt: string): Promise<PreviewResult> {
    const { validator } = this.ready()
    const resolved = await this.resolve(prompt)
    try {
      const result = validator.validate(resolved.sql)
      const blocked = result.violations.length > 0
      return {
        sql: result.sql,
        blocked,
        ...(blocked ? { reason: result.violations.join('; ') } : {}),
        operation: result.operation,
        tables: result.tables,
        warnings: result.warnings
      }
    } catch (error) {
      if (error instanceof ViolationError) {
        return {
          sql: resolved.sql,
          blocked: true,
          reason: error.message,
          layer: error.layer,
          operation: error.operation,
          tables: error.table ? [error.table] : [],
          warnings: []
        }
      }
      throw error
    }
  }

  public async explain(prompt: string): Promise<ExplainResult> {
    const prepared = await this.prepare(prompt)
    this.requireRead(prepared, prompt)
    const plan = await this.schema.explain(prepared.result.sql)
    this.remember(prepared, false)
    return { sql: prepared.result.sql, plan, warnings: prepared.result.warnings }
  }

  public cacheStats(): CacheStats {
    return this.ready().cache.getStats()
  }

  public last(): LastQuery | undefined {
    return this.lastQuery
  }

  public schemaContext(): SchemaContext {
    this.ready()
    return this.schema.getContext()
  }

  private async read(prompt: string): Promise<unknown[]> {
    const prepared = await this.prepare(prompt)
    this.requireRead(prepared, prompt)
    return this.execute(prepared, true)
  }

  private requireRead(prepared: Prepared, prompt: string): void {
    if (prepared.result.operation !== 'SELECT') {
      throw new Error(
        `PlainQL: read methods execute SELECT only; "${prompt}" produced ${prepared.result.operation} — use run()`
      )
    }
  }

  private async prepare(prompt: string): Promise<Prepared> {
    const { validator, cache } = this.ready()
    const resolved = await this.resolve(prompt)
    // Validate cached SQL too: the config may have changed since it was stored.
    const result = validator.validate(resolved.sql)

    // Only SQL that passed is worth remembering.
    if (resolved.source === 'ai') {
      await cache.store(prompt, {
        sql: resolved.sql,
        tables: result.tables,
        tokens: resolved.tokens,
        createdAt: Date.now()
      })
    }
    return { prompt, result, source: resolved.source, tokens: resolved.tokens }
  }

  private async resolve(prompt: string): Promise<{ sql: string; source: QuerySource; tokens: number }> {
    const { bridge, cache } = this.ready()
    if (!prompt.trim()) throw new Error('PlainQL: prompt must not be empty')

    const hit = cache.lookup(prompt)
    if (hit) return { sql: hit.entry.sql, source: hit.layer, tokens: 0 }

    const generated = await bridge.generate(prompt, this.schema.getContext())
    return { sql: generated.sql, source: 'ai', tokens: generated.tokens }
  }

  private async execute(prepared: Prepared, readOnly: boolean): Promise<unknown[]> {
    const { masker } = this.ready()
    const { result } = prepared

    const skip = this.config.security?.dryRun === true || result.violations.length > 0
    if (skip) {
      this.remember(prepared, false)
      return []
    }

    const rows = await this.schema.execute(result.sql, [], { readOnly })
    this.remember(prepared, true)
    return masker.apply(rows, result.tables)
  }

  private remember(prepared: Prepared, executed: boolean): void {
    this.lastQuery = {
      prompt: prepared.prompt,
      sql: prepared.result.sql,
      operation: prepared.result.operation,
      tables: prepared.result.tables,
      source: prepared.source,
      tokens: prepared.tokens,
      executed,
      warnings: prepared.result.warnings
    }
  }

  private async resolveStaticQueries(): Promise<void> {
    const { bridge, cache } = this.ready()
    const pending = Object.entries(this.config.queries ?? {}).filter(([name]) => !cache.getStatic(name))

    await Promise.all(pending.map(async ([name, prompt]) => {
      let generated
      try {
        generated = await bridge.generate(prompt, this.schema.getContext())
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        throw new Error(`PlainQL: could not resolve static query "${name}": ${message}`)
      }
      const entry: CacheEntry = { sql: generated.sql, tables: generated.tables, tokens: generated.tokens, createdAt: Date.now() }
      await cache.storeStatic(name, entry)
    }))
  }

  private ready(): Ready {
    if (!this.rules || !this.validator || !this.masker || !this.bridge || !this.cache) {
      throw new Error(NOT_CONNECTED)
    }
    return { rules: this.rules, validator: this.validator, masker: this.masker, bridge: this.bridge, cache: this.cache }
  }

}

interface Ready {
  rules: RuleSet
  validator: SecurityValidator
  masker: ResultMasker
  bridge: AIBridge
  cache: CacheManager
}

interface Prepared {
  prompt: string
  result: ValidationResult
  source: QuerySource
  tokens: number
}
