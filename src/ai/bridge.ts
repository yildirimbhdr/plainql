import Anthropic from '@anthropic-ai/sdk'
import type { AIConfig } from '../config/types.js'
import type { RuleSet } from '../security/rules.js'
import type { SchemaContext } from '../schema/types.js'
import { PromptBuilder, type BuiltPrompt, type PromptMode, type PromptOptions } from './prompt.js'

export class AIError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AIError'
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

export interface TokenUsage {
  input: number
  output: number
  cacheWrite: number
  cacheRead: number
}

export interface GenerateResult {
  sql: string
  tokens: number
  usage?: TokenUsage
  needTables?: string[]
}

export interface AIProvider {
  generate(prompt: BuiltPrompt): Promise<GenerateResult>
  countTokens?(user: string, system?: string): Promise<number>
}

export interface GeneratedSQL {
  sql: string
  tokens: number
  usage: TokenUsage
  tables: string[]
  mode: PromptMode
  rounds: number
}

export interface AIBridgeOptions extends PromptOptions {
  provider?: AIProvider
}

export class AIBridge {
  private provider: AIProvider
  private prompts: PromptBuilder

  constructor(config: AIConfig, rules: RuleSet, options: AIBridgeOptions = {}) {
    this.provider = options.provider ?? createProvider(config)
    this.prompts = new PromptBuilder(rules, options)
  }

  // In 'selected' mode the model may ask for tables it only saw by name; one
  // retry with those described in full is enough and keeps it from looping.
  public async generate(intent: string, context: SchemaContext): Promise<GeneratedSQL> {
    const first = this.prompts.build(intent, context)
    const reply = await this.provider.generate(first)
    if (reply.sql) {
      return { sql: reply.sql, tokens: reply.tokens, usage: addUsage(reply.usage), tables: first.tables, mode: first.mode, rounds: 1 }
    }
    if (first.mode === 'full') {
      throw new AIError('PlainQL: model returned no SQL although the whole schema was provided')
    }

    const missing = reply.needTables ?? []
    const second = this.prompts.build(intent, context, [...first.tables, ...missing])
    const added = second.tables.filter((name) => !first.tables.includes(name))
    if (added.length === 0) {
      throw new AIError(`PlainQL: model asked for tables that do not exist or are not visible: ${missing.join(', ')}`)
    }

    const retry = await this.provider.generate(second)
    const tokens = reply.tokens + retry.tokens
    if (!retry.sql) {
      throw new AIError(`PlainQL: model could not produce SQL even with ${second.tables.length} tables described`)
    }
    return {
      sql: retry.sql,
      tokens,
      usage: addUsage(reply.usage, retry.usage),
      tables: second.tables,
      mode: second.mode,
      rounds: 2
    }
  }

  public async measure(intent: string, context: SchemaContext): Promise<{ system: number; user: number } | undefined> {
    if (!this.provider.countTokens) return undefined
    const prompt = this.prompts.build(intent, context)
    const [all, userOnly] = await Promise.all([
      this.provider.countTokens(prompt.user, prompt.system),
      this.provider.countTokens(prompt.user)
    ])
    return { system: all - userOnly, user: userOnly }
  }

  public buildPrompt(intent: string, context: SchemaContext): BuiltPrompt {
    return this.prompts.build(intent, context)
  }
}

function addUsage(...parts: Array<TokenUsage | undefined>): TokenUsage {
  const total: TokenUsage = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 }
  for (const part of parts) {
    if (!part) continue
    total.input += part.input
    total.output += part.output
    total.cacheWrite += part.cacheWrite
    total.cacheRead += part.cacheRead
  }
  return total
}

export interface ParsedReply {
  sql: string
  needTables: string[]
}

// Structured output makes this a plain JSON.parse; fence stripping stays for
// providers without a JSON mode.
export function parseSQLResponse(text: string): ParsedReply {
  let body = text.trim()
  const fenced = body.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  if (fenced?.[1] !== undefined) body = fenced[1].trim()

  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    throw new AIError(`PlainQL: model reply is not valid JSON: ${preview(body)}`)
  }

  if (typeof parsed !== 'object' || parsed === null || !('sql' in parsed)) {
    throw new AIError(`PlainQL: model reply has no "sql" field: ${preview(body)}`)
  }

  const { sql, needTables } = parsed as { sql: unknown; needTables?: unknown }
  if (typeof sql !== 'string') {
    throw new AIError(`PlainQL: model reply "sql" must be a string: ${preview(body)}`)
  }

  const wanted = Array.isArray(needTables)
    ? needTables.filter((name): name is string => typeof name === 'string' && name.trim() !== '')
    : []
  if (sql.trim() === '' && wanted.length === 0) {
    throw new AIError(`PlainQL: model reply has neither SQL nor a table request: ${preview(body)}`)
  }

  return { sql: sql.trim(), needTables: wanted }
}

function preview(text: string): string {
  return text.length > 200 ? `${text.slice(0, 200)}…` : text
}

function createProvider(config: AIConfig): AIProvider {
  switch (config.provider) {
    case 'anthropic':
      return new AnthropicProvider(config)
    case 'openai':
    case 'ollama':
      throw new AIError(`PlainQL: AI provider "${config.provider}" is not implemented yet`)
    default:
      throw new AIError(`PlainQL: unknown AI provider "${String(config.provider)}"`)
  }
}

// Checked against the claude-api reference — do not change from memory.
const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-5"

const MAX_OUTPUT_TOKENS = 4096

const SQL_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    sql: { type: 'string' },
    needTables: { type: 'array', items: { type: 'string' } }
  },
  required: ['sql', 'needTables'],
  additionalProperties: false
} as const

export class AnthropicProvider implements AIProvider {
  private client: Anthropic
  private model: string
  private cacheTtl: '5m' | '1h'

  constructor(config: AIConfig) {
    // The SDK resolves ANTHROPIC_API_KEY itself; the key is never logged.
    this.client = config.apiKey ? new Anthropic({ apiKey: config.apiKey }) : new Anthropic()
    this.model = config.model ?? DEFAULT_ANTHROPIC_MODEL
    this.cacheTtl = config.promptCacheTtl ?? '5m'
  }

  public async generate(prompt: BuiltPrompt): Promise<GenerateResult> {
    let response: Anthropic.Message
    try {
      response = await this.client.messages.create({
        model: this.model,
        max_tokens: MAX_OUTPUT_TOKENS,
        // Translating one request into one statement rarely needs deep reasoning.
        output_config: {
          effort: 'medium',
          format: { type: 'json_schema', schema: SQL_OUTPUT_SCHEMA }
        },
        // The system prompt carries the schema and is identical call to call.
        system: [
          { type: 'text', text: prompt.system, cache_control: { type: 'ephemeral', ttl: this.cacheTtl } }
        ],
        messages: [{ role: 'user', content: prompt.user }]
      })
    } catch (error) {
      throw this.describe(error)
    }

    if (response.stop_reason === 'refusal') {
      throw new AIError('PlainQL: the model declined to generate SQL for this request')
    }
    if (response.stop_reason === 'max_tokens') {
      throw new AIError('PlainQL: model reply was cut off before the SQL was complete')
    }

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('')

    const parsed = parseSQLResponse(text)
    const usage = this.usageOf(response.usage)
    return {
      sql: parsed.sql,
      needTables: parsed.needTables,
      tokens: usage.input + usage.output + usage.cacheWrite + usage.cacheRead,
      usage
    }
  }

  public async countTokens(user: string, system?: string): Promise<number> {
    try {
      const counted = await this.client.messages.countTokens({
        model: this.model,
        ...(system ? { system } : {}),
        messages: [{ role: 'user', content: user }]
      })
      return counted.input_tokens
    } catch (error) {
      throw this.describe(error)
    }
  }

  private usageOf(usage: Anthropic.Usage): TokenUsage {
    return {
      input: usage.input_tokens,
      output: usage.output_tokens,
      cacheWrite: usage.cache_creation_input_tokens ?? 0,
      cacheRead: usage.cache_read_input_tokens ?? 0
    }
  }

    private describe(error: unknown): AIError {
    if (error instanceof Anthropic.AuthenticationError) {
      return new AIError('PlainQL: Anthropic rejected the API key — set config.ai.apiKey or ANTHROPIC_API_KEY')
    }
    if (error instanceof Anthropic.RateLimitError) {
      return new AIError('PlainQL: Anthropic rate limit reached — retry later')
    }
    if (error instanceof Anthropic.NotFoundError) {
      return new AIError(`PlainQL: Anthropic model "${this.model}" was not found`)
    }
    if (error instanceof Anthropic.BadRequestError && error.message.includes('anthropic-workspace-id')) {
      return new AIError('PlainQL: this Anthropic API key is not scoped to a workspace — create one under a workspace in the Anthropic Console')
    }
    if (error instanceof Anthropic.APIError) {
      return new AIError(`PlainQL: Anthropic API error ${error.status ?? ''}: ${error.message}`)
    }
    return new AIError(`PlainQL: AI call failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}
