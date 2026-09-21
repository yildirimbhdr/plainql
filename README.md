# plainql

**Policy-enforced natural-language SQL for Node.js.** An LLM writes the query; a four-layer validator decides what may run.

```ts
const pql = new PlainQL({ config, role: 'analyst' })
await pql.connect()

await pql.get('Top 10 products by revenue last month')   // rows
await pql.preview('Delete all users')                    // { sql, blocked: true, layer: 4, reason: '…' }
```

plainql is for the moment you have to let a model — a chat feature, an internal bot, an AI agent — talk to a real database. It talks to the database directly (`pg`, `mysql2`, `better-sqlite3`), sits next to any ORM or none, and never executes model output that has not passed every rule in your config.

> Status: **0.1 — early.** The security model and config shape are stable; the AI provider surface is Anthropic-only for now. Read [Limits](#limits) before putting it in front of untrusted users.

## Install

```bash
npm install plainql
npm install pg            # or mysql2, or better-sqlite3 — only the driver you use
```

Node 20+. ESM only.

## Quick start

```bash
export DATABASE_URL=postgres://user:pass@localhost:5432/app
export ANTHROPIC_API_KEY=sk-ant-…
npx plainql init            # writes plainql.config.ts from your schema
```

```ts
import { PlainQL } from 'plainql'
import config from './plainql.config.js'

const pql = new PlainQL({ config })
await pql.connect()                                  // introspects the schema, warms the cache

const users = await pql.get('Active users who signed up this week')
const total = await pql.count('How many orders today?')
const order = await pql.first('Order 1234 with its customer email')
await pql.run('Deactivate user 5')                   // INSERT / UPDATE / DELETE only

await pql.disconnect()
```

## How a call works

1. **Cache** — exact prompt, then a normalised fingerprint of it (so "list active users" and "the active users, please" share SQL). Hits cost 0 tokens.
2. **Model** — the prompt is sent with your schema, filtered for the active role: hidden columns and forbidden tables are never serialised. The schema sits in a cached system prompt, so after the first call each request costs a few dozen fresh tokens.
3. **Validator** — four layers, all must pass. Nothing is executed on failure.
4. **Execute** — reads go to `readOnlyUrl` when you have a replica; writes always hit the primary.
5. **Mask** — hidden columns are stripped from results and masked columns redacted, even if something upstream slipped.

The validator runs on every execution, cached or not, so changing the config takes effect immediately.

## The four layers

| Layer | What it enforces | Config |
|---|---|---|
| 1 | `DROP`, `TRUNCATE`, `ALTER` and multi-statement SQL are always refused; add your own keywords | `security.blockedOperations` |
| 2 | Per-table `allow`/`deny`; hidden columns may not be selected; `readonly`/`writable` columns in `UPDATE … SET` | `tables.<name>` |
| 3 | The active role's `globalAllow` and per-table rules; roles narrow, never widen; `extends` chains | `roles.<name>` |
| 4 | `UPDATE`/`DELETE` without `WHERE`; `deletePolicy.requireCondition` must appear in the `WHERE`; `LIMIT` injected or clamped to `maxRows` | `security.requireWhereClause`, `tables.<name>.requireWhere`, `maxRows` |

Failures throw a `ViolationError { layer, operation, table?, column? }` with a message that names the rule. `onViolation: 'warn'` logs and skips execution instead; `'ignore'` disables layers 2–4 (layer 1 cannot be softened).

## Configuration

```ts
import { defineConfig } from 'plainql'

export default defineConfig({
  connection: {
    url: process.env.DATABASE_URL!,
    readOnlyUrl: process.env.DATABASE_READONLY_URL      // optional replica for reads
  },

  security: {
    blockedOperations: ['GRANT', 'LOAD'],
    requireWhereClause: true,                            // no UPDATE/DELETE without WHERE, anywhere
    dryRun: process.env.CI === 'true',                   // validate, never execute
    onViolation: 'throw'                                 // 'throw' | 'warn' | 'ignore'
  },

  // What the schema cannot say. Sent with every request, cached by the provider.
  context: 'Amounts are in cents. Localised text columns hold a JSON object keyed by locale.',

  tables: {
    users: {
      allow: ['SELECT', 'UPDATE'],
      description: 'People who can log in; soft-deleted rows have deleted_at set',
      columns: {
        hidden: ['password_hash', 'mfa_secret'],         // never sent to the model, stripped from results
        readonly: ['id', 'created_at'],                  // cannot appear in UPDATE … SET
        masked: { phone: 'last4', email: 'partial' },    // redacted in results
        hints: { status: 'one of active | banned | pending' }
      },
      maxRows: 500,
      requireWhere: ['UPDATE']
    },
    product: {
      allow: ['SELECT'],
      columns: {
        hints: { name: 'JSON keyed by locale, e.g. {"nl":"…"}; match with JSON_EXTRACT(name, \'$.nl\')' }
      }
    },
    audit_log: { allow: ['SELECT', 'DELETE'], deletePolicy: { requireCondition: 'created_at <' } },
    payments: { allow: [] }                              // invisible to the model
  },

  roles: {
    analyst: { globalAllow: ['SELECT'] },
    support: { extends: 'analyst', tables: { users: { allow: ['SELECT', 'UPDATE'] } } }
  },

  // Named queries whose SQL is generated once at connect() and reused for free.
  queries: {
    activeUsers: 'All users whose status is active, newest first'
  },

  ai: {
    provider: 'anthropic',
    model: 'claude-sonnet-5',                            // optional
    promptCacheTtl: '5m',                                // '5m' | '1h' provider-side schema cache
    cache: { storage: 'file', ttl: 86_400, intent: true }
  }
})
```

Tables you do not list are fully allowed. Roles can only remove permissions the table rule grants.

### Notes for the model

Column names lie. `description`, `columns.hints` and the top-level `context` are how you tell the model that `gift_type` takes three specific values or that `name` is a JSON blob keyed by locale. They are serialised next to the schema (so cached, so free), and a hint is never emitted for a hidden column.

## API

| Method | Returns | Notes |
|---|---|---|
| `connect()` | `void` | Required first. Introspects, loads the cache, resolves `config.queries`. |
| `get(prompt)` | `unknown[]` | SELECT only |
| `first(prompt)` | `unknown \| null` | |
| `count(prompt)` | `number` | Unwraps a one-cell result, else row count |
| `run(prompt)` | `void` | INSERT / UPDATE / DELETE only |
| `query(name)` | `unknown[]` | A `config.queries` entry, 0 tokens |
| `preview(prompt)` | `{ sql, blocked, reason?, layer?, tables }` | Never executes |
| `explain(prompt)` | `{ sql, plan, warnings }` | The database's plan; never executes |
| `last()` | `{ sql, source, tokens, executed, … }` | Audit record of the previous call |
| `cacheStats()` | `{ hits, misses, tokensSaved }` | |
| `disconnect()` | `void` | |

`new PlainQL({ config, role?, aiProvider? })` — `aiProvider` is any object with `generate(prompt) → { sql, tokens }`, for tests or other backends.

## CLI

```
plainql init --url <database url> [--out plainql.config.ts] [--force]
```

Writes a starting config: every table read-only with a row cap, columns that look like secrets hidden, contact columns masked. The connection string is not written into the file.

## Limits

Be clear-eyed about what a policy layer can and cannot do.

- **It bounds scope, not intent.** If a role may read `customers`, a prompt can read all of `customers` — through your feature or through a prompt injection. Give roles the narrowest tables and columns they need.
- **No row-level rules yet.** There is no "only rows where `tenant_id = ?`". Do not expose plainql to end users of a multi-tenant application until there is.
- **Models are probabilistic.** The validator guarantees a query is *permitted*, not that it is *right*. Use `preview()` and `explain()` in review flows, and `queries` for anything that must be exact.
- **Intent cache.** Rephrasings share SQL by normalised word set. Words that change meaning (`not`, `today`, numbers) are kept, but if that is still too loose for you, set `ai.cache.intent: false`.
- **Providers.** Anthropic only in 0.1. The `AIProvider` interface is small; OpenAI/Ollama are next.

## Development

```bash
npm test                     # vitest, SQLite in-memory — no services needed
POSTGRES_URL=postgres://postgres:pg@localhost:5432/plainql_test \
MYSQL_URL=mysql://root@localhost:3306/plainql_test npm test     # also runs the driver suites
```

MIT © Bahadır Yıldırım
