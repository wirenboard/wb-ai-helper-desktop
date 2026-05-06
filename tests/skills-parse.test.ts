import { describe, test, expect } from 'bun:test'
import { extractDescription } from '../src/server/skills.ts'

describe('extractDescription', () => {
  test('extracts first paragraph after heading', () => {
    const md = '# My Skill\n\nThis is a detailed description of the skill that does things.\n\n## Details\n...'
    expect(extractDescription(md)).toBe('This is a detailed description of the skill that does things.')
  })

  test('skips blank lines between heading and paragraph', () => {
    const md = '# Skill\n\n\n\nThis paragraph comes after several blanks and is long enough.'
    expect(extractDescription(md)).toBe('This paragraph comes after several blanks and is long enough.')
  })

  test('stops at next heading', () => {
    const md = '# Skill\n\nFirst paragraph is long enough to pass.\n## Second heading\nMore text'
    expect(extractDescription(md)).toBe('First paragraph is long enough to pass.')
  })

  test('stops at empty line after paragraph', () => {
    const md = '# Skill\n\nThis line is the description content here.\n\nAnother paragraph not included.'
    expect(extractDescription(md)).toBe('This line is the description content here.')
  })

  test('throws on missing heading', () => {
    expect(() => extractDescription('No heading here, just text.\nMore text.')).toThrow('нет заголовка')
  })

  test('throws when description is too short', () => {
    const md = '# Skill\n\nShort.'
    expect(() => extractDescription(md)).toThrow('>=20 символов')
  })

  test('collapses whitespace', () => {
    const md = '# Skill\n\nThis   has   extra   spaces   and   is   long   enough   overall.'
    expect(extractDescription(md)).toBe('This has extra spaces and is long enough overall.')
  })

  test('multi-line paragraph joined into single string', () => {
    const md = '# Skill\n\nLine one of the paragraph description.\nLine two continues the same paragraph.'
    const desc = extractDescription(md)
    expect(desc).toContain('Line one')
    expect(desc).toContain('Line two')
    expect(desc).not.toContain('\n')
  })
})
