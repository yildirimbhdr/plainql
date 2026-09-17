/**
 * The same package outside a server: a one-off script.
 *
 * Run with:  DATABASE_URL=mysql://root@localhost:3306/kiosk_local tsx script.ts
 */
import { PlainQL } from 'plainql'
import config from './plainql.config.js'

const pql = new PlainQL({ config, role: 'analyst' })
await pql.connect()

// Plain questions in, rows out.
const patients = await pql.get('Last 10 registered patients')
console.table(patients)

const total = await pql.count('How many kiosks are registered?')
console.log('kiosks:', total)

// See the SQL without running it — handy while writing the prompt.
const { sql, blocked, reason } = await pql.preview('Delete every patient')
console.log({ sql, blocked, reason })

// Check what the database will actually do with a query.
const { plan, warnings } = await pql.explain('Patient transactions grouped by hospital')
console.log(plan, warnings)

console.log(pql.cacheStats())   // { hits, misses, tokensSaved }

await pql.disconnect()
