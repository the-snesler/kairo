import { existsSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { loadEnvFile } from 'node:process'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import * as schema from './schema/index.js'

function workspaceRoot() {
  let root = process.cwd()
  while (!existsSync(resolve(root, 'pnpm-workspace.yaml')) && dirname(root) !== root) root = dirname(root)
  return root
}

const root = workspaceRoot()
const envFile = resolve(root, '.env')
if (existsSync(envFile)) loadEnvFile(envFile)

function databasePath() {
  const value = process.env.DATABASE_URL ?? './data/kairo.db'
  if (value === ':memory:') return value
  return resolve(root, value.startsWith('file:') ? value.slice(5) : value)
}

const path = databasePath()
if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
export const sqlite = new Database(path)
sqlite.pragma('journal_mode = WAL')
sqlite.pragma('foreign_keys = ON')
sqlite.pragma('busy_timeout = 5000')
export const db = drizzle(sqlite, { schema })
export const getDb = () => db

export type DatabaseClient = typeof db
