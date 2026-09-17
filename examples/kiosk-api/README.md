# Example — kiosk API

How plainql is meant to be used once the package is finished. The rules here
match the real `kiosk_local` schema.

> Status: `plainql.config.ts` and the security rules work today. The query
> methods (`get`, `first`, `count`, `run`, `query`, `preview`, `explain`) need
> the AI bridge, the cache and the client pipeline, which are not built yet.

## Files

| File | What it shows |
|---|---|
| `plainql.config.ts` | The whole security policy: tables, columns, roles |
| `server.ts` | Express API — one client per role, created at boot |
| `script.ts` | The same package in a one-off script |

## Install

```bash
npm install plainql
export DATABASE_URL="mysql://user:pass@localhost:3306/kiosk_local"
export ANTHROPIC_API_KEY="sk-ant-..."
```

## The shape of it

```ts
const pql = new PlainQL({ config, role: 'analyst' })
await pql.connect()                      // once at boot

await pql.get('Last 10 registered patients')
await pql.count('How many kiosks are registered?')
await pql.run('Set the phone of patient 5 to 5551234')   // needs a writing role
await pql.query('todaysTransactions')                    // named query, 0 tokens
await pql.preview('Delete every patient')                // returns SQL, runs nothing
```

`connect()` reads the schema once. Every call after that goes through the cache
before it reaches the model, and through the validator before it reaches the
database.

## What the config buys you

With the rules in `plainql.config.ts`:

```ts
await analyst.get('Show me every user with their password')
// ViolationError: column "password" on table "directus_users" is hidden

await analyst.get('List patient national ids')
// ViolationError: column "identity_no" on table "user" is hidden

await analyst.run('Delete all transactions')
// ViolationError: role does not permit DELETE on table "patient_transaction"

await analyst.get('Show recent login sessions')
// ViolationError: SELECT is not allowed on table "directus_sessions"

await support.run("Change patient 5's name to X")
// ViolationError: column "name" on table "user" is not writable (allowed: phone, gender)
```

None of this depends on the model refusing. The SQL comes back, the validator
rejects it, and nothing runs.

Rows that do come back are cleaned on the way out:

```ts
await analyst.get('Last 3 patients')
// [{ id: 4, name: 'MU***', surname: 'KI***', gender: 'ERKEK' }, …]
// identity_no is not in the object at all
```

## Roles

```ts
const analyst = new PlainQL({ config, role: 'analyst' })   // reads, no staff table
const support = new PlainQL({ config, role: 'support' })   // reads + patient contact edits
```

A role only ever narrows the table rules. `support` cannot grant itself DELETE,
and no role can unhide a hidden column — a config that tries is simply ignored
in that direction.

## Errors

`ViolationError` carries the layer, table and column, which maps cleanly onto a
403:

```ts
if (error instanceof ViolationError) {
  res.status(403).json({ error: error.message, layer: error.layer })
}
```

## Cost

The cache resolves repeated prompts before the model is called:

1. Same prompt seen before → cached SQL, 0 tokens
2. Named query from `config.queries` → generated at boot, 0 tokens
3. Same intent, different wording → cached SQL, minimal tokens
4. Otherwise → the model generates SQL, and the result is cached

```ts
pql.cacheStats()   // { hits: 1420, misses: 37, tokensSaved: 412_000 }
```

A hot endpoint converges on zero AI calls.
