import { fileURLToPath } from 'node:url'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { db } from './db.js'

const migrationsFolder = fileURLToPath(new URL('../migrations/', import.meta.url))
export function migrateDatabase() {
  migrate(db, { migrationsFolder })
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) migrateDatabase()
