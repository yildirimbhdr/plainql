/**
 * A small Express API backed by plainql.
 *
 * The pattern: create one PlainQL instance per role at boot, connect once, then
 * call it from route handlers like any other data source.
 */
import express from 'express'
import { PlainQL, ViolationError } from 'plainql'
import config from './plainql.config.js'

const app = express()
app.use(express.json())

// One client per role. connect() introspects the schema and resolves the named
// queries in config.queries, so it runs once at boot — never per request.
const analyst = new PlainQL({ config, role: 'analyst' })
const support = new PlainQL({ config, role: 'support' })

await analyst.connect()
await support.connect()

// ── Reading ──────────────────────────────────────────────────

app.get('/patients/recent', async (_req, res) => {
  // Hidden columns are stripped and masked ones redacted before this returns,
  // so identity_no can never reach the response body.
  const rows = await analyst.get('Last 20 registered patients with name and gender')
  res.json(rows)
})

app.get('/transactions/count', async (_req, res) => {
  const total = await analyst.count('How many patient transactions were created today?')
  res.json({ total })
})

app.get('/kiosks/:id', async (req, res) => {
  const kiosk = await analyst.first(`Get the kiosk with id ${req.params.id}`)
  if (!kiosk) return res.status(404).json({ error: 'not found' })
  res.json(kiosk)
})

// A named query from config.queries: the SQL was generated at boot, so this
// costs no tokens at all.
app.get('/transactions/today', async (_req, res) => {
  res.json(await analyst.query('todaysTransactions'))
})

// ── Writing ──────────────────────────────────────────────────

app.patch('/patients/:id/phone', async (req, res) => {
  // Only `support` may write, and only to phone/gender — the config says so,
  // and the validator enforces it whatever SQL the model produces.
  await support.run(
    `Set the phone of patient ${req.params.id} to ${req.body.phone}`
  )
  res.json({ ok: true })
})

// ── Inspecting without executing ──────────────────────────────

// Useful for an admin console: shows what would run, and why it would not.
app.post('/admin/preview', async (req, res) => {
  const result = await analyst.preview(req.body.prompt)
  res.json(result)   // { sql, blocked, reason? }
})

app.get('/admin/cache', (_req, res) => {
  res.json(analyst.cacheStats())   // { hits, misses, tokensSaved }
})

// ── Errors ───────────────────────────────────────────────────

app.use((error: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (res.headersSent) return next(error)

  // A ViolationError means a rule stopped the query — that is a 403, not a 500,
  // and its message already names the layer, table and column.
  if (error instanceof ViolationError) {
    return res.status(403).json({
      error: error.message,
      layer: error.layer,
      table: error.table,
      column: error.column
    })
  }

  console.error(error)
  res.status(500).json({ error: 'internal error' })
})

app.listen(3000, () => console.log('kiosk api on :3000'))

// Close the pools on shutdown so the process can exit cleanly.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    await Promise.all([analyst.disconnect(), support.disconnect()])
    process.exit(0)
  })
}
