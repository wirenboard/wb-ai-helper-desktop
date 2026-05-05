import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { DbHandle } from './db.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SKILLS_DIR = join(__dirname, 'fixtures', 'skills')

export interface Skill {
  name: string
  description: string
  content: string
  origin: 'system' | 'user'
  updated_at: number
}

export const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/

// Per-session loaded skills (in-memory) — re-injected as system messages each LLM turn
const loadedSkillsBySession = new Map<string, Map<string, string>>()

export function trackLoadedSkill(sessionId: string, name: string, content: string): void {
  if (!loadedSkillsBySession.has(sessionId)) loadedSkillsBySession.set(sessionId, new Map())
  loadedSkillsBySession.get(sessionId)!.set(name, content)
}

export function getLoadedSkills(sessionId: string): { name: string; content: string }[] {
  const map = loadedSkillsBySession.get(sessionId)
  if (!map) return []
  return [...map.entries()].map(([name, content]) => ({ name, content }))
}

export function unloadSkillFromSession(sessionId: string, name: string): boolean {
  return loadedSkillsBySession.get(sessionId)?.delete(name) ?? false
}

// DB operations

export function listSkills(db: DbHandle): Skill[] {
  return db
    .query<Skill, []>(
      `SELECT name, description, content, origin, updated_at FROM skills
       ORDER BY origin = 'system' DESC, name`,
    )
    .all()
}

export function getSkill(db: DbHandle, name: string): Skill | null {
  return (
    db
      .query<Skill, [string]>(
        'SELECT name, description, content, origin, updated_at FROM skills WHERE name = ?',
      )
      .get(name) ?? null
  )
}

export function upsertSystemSkill(
  db: DbHandle,
  s: { name: string; description: string; content: string },
): void {
  db
    .query(
      `INSERT INTO skills (name, description, content, origin, updated_at) VALUES (?, ?, ?, 'system', ?)
       ON CONFLICT(name) DO UPDATE SET
         description = excluded.description,
         content     = excluded.content,
         origin      = 'system',
         updated_at  = excluded.updated_at`,
    )
    .run(s.name, s.description, s.content, Date.now())
}

export function upsertUserSkill(
  db: DbHandle,
  s: { name: string; description: string; content: string },
): { ok: true } | { ok: false; error: string } {
  const existing = getSkill(db, s.name)
  if (existing?.origin === 'system') {
    return { ok: false, error: `скилл "${s.name}" системный, через чат не перезаписывается` }
  }
  db
    .query(
      `INSERT INTO skills (name, description, content, origin, updated_at) VALUES (?, ?, ?, 'user', ?)
       ON CONFLICT(name) DO UPDATE SET
         description = excluded.description,
         content     = excluded.content,
         updated_at  = excluded.updated_at`,
    )
    .run(s.name, s.description, s.content, Date.now())
  return { ok: true }
}

export function deleteUserSkill(
  db: DbHandle,
  name: string,
): { ok: true } | { ok: false; error: string } {
  const existing = getSkill(db, name)
  if (!existing) return { ok: false, error: `скилл "${name}" не найден` }
  if (existing.origin === 'system') {
    return { ok: false, error: `скилл "${name}" системный, через чат не удаляется` }
  }
  db.query('DELETE FROM skills WHERE name = ?').run(name)
  return { ok: true }
}

/** Remove system skills from DB that are no longer in the fixtures directory. */
function pruneSystemSkillsNotIn(db: DbHandle, names: string[]): void {
  const list = names.length ? `'${names.map((n) => n.replace(/'/g, "''")).join("','")}'` : "''"
  db.exec(`DELETE FROM skills WHERE origin = 'system' AND name NOT IN (${list})`)
}

/** Seed system skills from fixtures/skills/*.md into the DB. Called at startup. */
export function seedSystemSkills(db: DbHandle): void {
  let files: string[] = []
  try {
    files = readdirSync(SKILLS_DIR).filter((f) => f.endsWith('.md'))
  } catch {
    return
  }
  const names: string[] = []
  for (const file of files) {
    const raw = readFileSync(join(SKILLS_DIR, file), 'utf8')
    const name = basename(file, '.md')
    try {
      const description = extractDescription(raw, file)
      upsertSystemSkill(db, { name, description, content: raw })
      names.push(name)
    } catch (e) {
      console.warn(`[skills] пропущен ${file}: ${e}`)
    }
  }
  pruneSystemSkillsNotIn(db, names)
  if (names.length) console.log(`[skills] загружено ${names.length} системных скиллов`)
}

export function extractDescription(raw: string, label = 'skill'): string {
  const lines = raw.split('\n')
  let i = 0
  while (i < lines.length && !/^#\s+\S/.test(lines[i]!)) i++
  if (i >= lines.length) throw new Error(`${label}: нет заголовка # <name>`)
  i++
  while (i < lines.length && lines[i]!.trim() === '') i++
  const start = i
  while (i < lines.length && lines[i]!.trim() !== '' && !/^#/.test(lines[i]!)) i++
  const description = lines.slice(start, i).join(' ').replace(/\s+/g, ' ').trim()
  if (description.length < 20) {
    throw new Error(`${label}: первый абзац после # должен быть содержательным описанием (>=20 символов)`)
  }
  return description
}
