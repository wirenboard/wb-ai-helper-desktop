import { Database } from 'bun:sqlite'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

export type DbHandle = Database

export async function openDb(file?: string): Promise<DbHandle> {
  const target = file ?? defaultDbPath()
  await mkdir(path.dirname(target), { recursive: true })
  const db = new Database(target, { create: true })
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA synchronous = NORMAL')
  migrate(db)
  return db
}

function migrate(db: Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chats (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      context_sns TEXT NOT NULL DEFAULT '[]'
    );

    CREATE TABLE IF NOT EXISTS turns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      ord INTEGER NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      tool_call_id TEXT,
      tool_calls TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS turns_chat_ord ON turns(chat_id, ord);

    CREATE TABLE IF NOT EXISTS manual_controllers (
      sn TEXT PRIMARY KEY,
      host TEXT NOT NULL,
      added_at INTEGER NOT NULL
    );
  `)

  // Token columns added after initial schema — IF NOT EXISTS is safe on any SQLite 3.35+
  db.exec(`ALTER TABLE turns ADD COLUMN IF NOT EXISTS tokens_prompt INTEGER NOT NULL DEFAULT 0`)
  db.exec(`ALTER TABLE turns ADD COLUMN IF NOT EXISTS tokens_completion INTEGER NOT NULL DEFAULT 0`)
}

function defaultDbPath(): string {
  const exe = process.execPath
  const isCompiled = exe && !path.basename(exe).startsWith('bun')
  if (isCompiled) return path.join(path.dirname(exe), 'wb-ai-helper.db')
  const cfg =
    process.platform === 'win32'
      ? path.join(process.env['APPDATA'] ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'wb-ai-helper')
      : path.join(process.env['XDG_CONFIG_HOME'] ?? path.join(os.homedir(), '.config'), 'wb-ai-helper')
  return path.join(cfg, 'wb-ai-helper.db')
}
