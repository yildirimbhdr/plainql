import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export interface CacheOptions {
  enabled?: boolean
  ttl?: number
  storage?: 'file' | 'memory'
  dir?: string
  intent?: boolean
}

export interface CacheEntry {
  sql: string
  tables: string[]
  /** What generating it cost — what a hit saves. */
  tokens: number
  createdAt: number
}

export interface CacheStats {
  hits: number
  misses: number
  tokensSaved: number
}

export type CacheLayer = 'exact' | 'static' | 'intent'

export interface CacheHit {
  entry: CacheEntry
  layer: CacheLayer
}

interface RoleBucket {
  exact: Record<string, CacheEntry>
  intent: Record<string, CacheEntry>
  static: Record<string, CacheEntry>
}

interface CacheFile {
  version: 1
  schemaHash: string
  roles: Record<string, RoleBucket>
}

const FILE_VERSION = 1
const FILE_NAME = 'cache.json'

// Deliberately short: anything that could flip the SQL (not, count, today, 10) stays in.
const FILLER_WORDS = new Set([
  'a', 'an', 'the', 'of', 'in', 'on', 'at', 'to', 'for', 'from', 'by', 'with', 'and',
  'me', 'i', 'us', 'my', 'our', 'please', 'all',
  'show', 'list', 'get', 'give', 'fetch', 'find', 'return', 'select', 'display', 'retrieve'
])

export class CacheManager {
  private options: Required<Pick<CacheOptions, 'enabled' | 'storage' | 'intent'>> & CacheOptions
  private schemaHash: string
  private role: string
  private roles: Record<string, RoleBucket> = {}
  private stats: CacheStats = { hits: 0, misses: 0, tokensSaved: 0 }
  private loaded = false
  private writing: Promise<void> = Promise.resolve()

  constructor(options: CacheOptions, scope: { schemaHash: string; role?: string }) {
    this.options = {
      ...options,
      enabled: options.enabled ?? true,
      storage: options.storage ?? 'file',
      intent: options.intent ?? true
    }
    this.schemaHash = scope.schemaHash
    this.role = scope.role ?? ''
  }

  public static hashSchema(tables: Array<{ name: string; columns: Array<{ name: string; type: string }> }>): string {
    const digest = createHash('sha1')
    for (const table of tables) {
      digest.update(table.name)
      for (const column of table.columns) digest.update(`|${column.name}:${column.type}`)
      digest.update('\n')
    }
    return digest.digest('hex')
  }

  public static fingerprint(prompt: string): string {
    const words = prompt
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((word) => word && !FILLER_WORDS.has(word))
    return [...new Set(words)].sort().join(' ')
  }

  public async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    if (!this.options.enabled || this.options.storage !== 'file') return

    let raw: string
    try {
      raw = await readFile(this.filePath(), 'utf8')
    } catch {
      return
    }

    let parsed: Partial<CacheFile>
    try {
      parsed = JSON.parse(raw) as Partial<CacheFile>
    } catch {
      return
    }
    if (parsed.version !== FILE_VERSION || parsed.schemaHash !== this.schemaHash || !parsed.roles) return
    this.roles = parsed.roles
  }

  public getStats(): CacheStats {
    return { ...this.stats }
  }

  public lookup(prompt: string): CacheHit | undefined {
    if (!this.options.enabled) return undefined
    const bucket = this.bucket()

    const exact = this.fresh(bucket.exact[prompt])
    if (exact) return this.hit(exact, 'exact')

    if (this.options.intent) {
      const intent = this.fresh(bucket.intent[CacheManager.fingerprint(prompt)])
      if (intent) return this.hit(intent, 'intent')
    }

    this.stats.misses += 1
    return undefined
  }

  public getStatic(name: string): CacheEntry | undefined {
    if (!this.options.enabled) return undefined
    return this.fresh(this.bucket().static[name])
  }

  public async store(prompt: string, entry: CacheEntry): Promise<void> {
    if (!this.options.enabled) return
    const bucket = this.bucket()
    bucket.exact[prompt] = entry
    if (this.options.intent) bucket.intent[CacheManager.fingerprint(prompt)] = entry
    await this.persist()
  }

  public async storeStatic(name: string, entry: CacheEntry): Promise<void> {
    if (!this.options.enabled) return
    this.bucket().static[name] = entry
    await this.persist()
  }

  private hit(entry: CacheEntry, layer: CacheLayer): CacheHit {
    this.stats.hits += 1
    this.stats.tokensSaved += entry.tokens
    return { entry, layer }
  }

  private fresh(entry: CacheEntry | undefined): CacheEntry | undefined {
    if (!entry) return undefined
    if (this.options.ttl !== undefined && Date.now() - entry.createdAt > this.options.ttl * 1000) {
      return undefined
    }
    return entry
  }

  private bucket(): RoleBucket {
    let bucket = this.roles[this.role]
    if (!bucket) {
      bucket = { exact: {}, intent: {}, static: {} }
      this.roles[this.role] = bucket
    }
    return bucket
  }

  private filePath(): string {
    return join(this.options.dir ?? '.plainql', FILE_NAME)
  }

  // Serialised so concurrent stores cannot interleave; temp file + rename keeps the file whole.
  private persist(): Promise<void> {
    if (this.options.storage !== 'file') return Promise.resolve()
    this.writing = this.writing.then(() => this.writeFile()).catch(() => undefined)
    return this.writing
  }

  private async writeFile(): Promise<void> {
    const file: CacheFile = { version: FILE_VERSION, schemaHash: this.schemaHash, roles: this.prune() }
    const path = this.filePath()
    await mkdir(dirname(path), { recursive: true })
    const temp = `${path}.${process.pid}.tmp`
    await writeFile(temp, JSON.stringify(file, null, 2))
    await rename(temp, path)
  }

  private prune(): Record<string, RoleBucket> {
    if (this.options.ttl === undefined) return this.roles
    const cutoff = Date.now() - this.options.ttl * 1000
    const keep = (entries: Record<string, CacheEntry>): Record<string, CacheEntry> =>
      Object.fromEntries(Object.entries(entries).filter(([, entry]) => entry.createdAt > cutoff))

    const pruned: Record<string, RoleBucket> = {}
    for (const [role, bucket] of Object.entries(this.roles)) {
      pruned[role] = { exact: keep(bucket.exact), intent: keep(bucket.intent), static: keep(bucket.static) }
    }
    return pruned
  }

}
