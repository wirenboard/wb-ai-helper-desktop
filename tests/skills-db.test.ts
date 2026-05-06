import { describe, test, expect, beforeAll } from 'bun:test'
import { openDb, type DbHandle } from '../src/server/db.ts'
import {
  listSkills, getSkill, upsertSystemSkill, upsertUserSkill,
  deleteUserSkill, trackLoadedSkill, getLoadedSkills, unloadSkillFromSession,
} from '../src/server/skills.ts'

let db: DbHandle

beforeAll(async () => {
  db = await openDb(':memory:')
})

describe('skills DB operations', () => {
  test('listSkills returns empty on fresh DB', () => {
    expect(listSkills(db)).toEqual([])
  })

  test('upsertSystemSkill inserts a skill', () => {
    upsertSystemSkill(db, { name: 'sys-test', description: 'A system skill', content: '# Sys\n\nContent here.' })
    const skill = getSkill(db, 'sys-test')
    expect(skill).not.toBeNull()
    expect(skill?.origin).toBe('system')
    expect(skill?.description).toBe('A system skill')
  })

  test('getSkill returns null for non-existent', () => {
    expect(getSkill(db, 'nope')).toBeNull()
  })

  test('upsertUserSkill inserts with origin=user', () => {
    const result = upsertUserSkill(db, { name: 'user-test', description: 'A user skill', content: 'body' })
    expect(result.ok).toBe(true)
    expect(getSkill(db, 'user-test')?.origin).toBe('user')
  })

  test('upsertUserSkill refuses to overwrite system skill', () => {
    upsertSystemSkill(db, { name: 'protected', description: 'system', content: 'body' })
    const result = upsertUserSkill(db, { name: 'protected', description: 'override', content: 'new' })
    expect(result.ok).toBe(false)
  })

  test('deleteUserSkill removes user skill', () => {
    upsertUserSkill(db, { name: 'to-delete', description: 'deletable', content: 'x' })
    const result = deleteUserSkill(db, 'to-delete')
    expect(result.ok).toBe(true)
    expect(getSkill(db, 'to-delete')).toBeNull()
  })

  test('deleteUserSkill refuses to delete system skill', () => {
    const result = deleteUserSkill(db, 'sys-test')
    expect(result.ok).toBe(false)
  })

  test('deleteUserSkill returns error for non-existent', () => {
    const result = deleteUserSkill(db, 'nope-nope')
    expect(result.ok).toBe(false)
  })

  test('listSkills returns all skills', () => {
    const all = listSkills(db)
    expect(all.length).toBeGreaterThanOrEqual(2) // sys-test + user-test was deleted, but protected + sys-test remain
  })
})

describe('in-memory skill tracking', () => {
  test('trackLoadedSkill + getLoadedSkills round-trip', () => {
    trackLoadedSkill('s1', 'my-skill', 'content here')
    const loaded = getLoadedSkills('s1')
    expect(loaded).toHaveLength(1)
    expect(loaded[0]?.name).toBe('my-skill')
    expect(loaded[0]?.content).toBe('content here')
  })

  test('getLoadedSkills returns empty for unknown session', () => {
    expect(getLoadedSkills('unknown-sess')).toEqual([])
  })

  test('unloadSkillFromSession removes and returns true', () => {
    trackLoadedSkill('s2', 'temp-skill', 'c')
    expect(unloadSkillFromSession('s2', 'temp-skill')).toBe(true)
    expect(getLoadedSkills('s2')).toEqual([])
  })

  test('unloadSkillFromSession returns false for miss', () => {
    expect(unloadSkillFromSession('s2', 'nonexistent')).toBe(false)
  })
})
