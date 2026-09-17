/**
 * Security policy for the kiosk API.
 *
 * This file is the whole security surface: what the AI may see, what it may
 * query, and what it may never return. Nothing here depends on the AI behaving
 * well — every rule is enforced after the SQL comes back.
 */
import { defineConfig } from 'plainql'

export default defineConfig({
  connection: {
    url: process.env.DATABASE_URL!,
  },

  security: {
    requireWhereClause: true,
    onViolation: 'throw'
  },

  tables: {
    directus_users: {
      allow: ['SELECT'],
      columns: {
        hidden: ['password', 'tfa_secret', 'token', 'auth_data'],
        masked: { email: 'partial' }
      },
      maxRows: 50
    },

    user: {
      allow: ['SELECT', 'UPDATE'],
      columns: {
        hidden: ['identity_no'],
        readonly: ['id', 'register_date'],
        writable: ['phone', 'gender'],
        masked: { name: 'partial', surname: 'partial' }
      },
      maxRows: 100
    },

    kiosk: {
      allow: ['SELECT'],
      columns: { hidden: ['remote_connect_password'] }
    },

    patient_transaction: { allow: ['SELECT'], maxRows: 500 },
    hospital: { allow: ['SELECT'] },

    // Audit trail is off limits to every role.
    directus_sessions: { allow: [] },
    directus_activity: { allow: [] }
  },

  roles: {
    // Base role every other one narrows from.
    viewer: {
      globalAllow: ['SELECT']
    },

    // Analysts read everything a viewer can, minus staff accounts.
    analyst: {
      extends: 'viewer',
      tables: {
        directus_users: { allow: [] }
      }
    },

    // Support may update patient contact details, nothing else.
    support: {
      globalAllow: ['SELECT', 'UPDATE'],
      tables: {
        user: { allow: ['SELECT', 'UPDATE'] }
      }
    }
  },

  // Named queries: SQL is generated once at boot, then reused for free.
  queries: {
    todaysTransactions: 'Count patient transactions created today',
    activeKiosks: 'List kiosks that reported status in the last hour'
  },

  ai: {
    provider: 'anthropic',
    cache: { enabled: true, ttl: 86400, storage: 'file' }
  }
})
