import { describe, test, expect } from 'bun:test'
import { splitSections, parseDpkgVerify, diffArrays } from '../src/server/audit.ts'

describe('splitSections', () => {
  test('parses multiple sections', () => {
    const input = '===WB-AUDIT===fw\n7.4.0\n===WB-AUDIT===release\nSUITE=stable\nTARGET=wb7\n===WB-AUDIT===end'
    const result = splitSections(input)
    expect(result['fw']).toEqual(['7.4.0'])
    expect(result['release']).toEqual(['SUITE=stable', 'TARGET=wb7'])
    expect(result['end']).toEqual([])
  })

  test('skips empty lines within sections', () => {
    const input = '===WB-AUDIT===test\nhello\n\nworld\n===WB-AUDIT===end'
    expect(splitSections(input)['test']).toEqual(['hello', 'world'])
  })

  test('text before first marker is ignored', () => {
    const input = 'garbage\n===WB-AUDIT===foo\nbar\n===WB-AUDIT===end'
    expect(splitSections(input)['foo']).toEqual(['bar'])
    expect(Object.keys(splitSections(input))).not.toContain('')
  })

  test('empty input returns empty object', () => {
    expect(splitSections('')).toEqual({})
  })
})

describe('parseDpkgVerify', () => {
  test('parses standard dpkg verify output', () => {
    const lines = ['??5...... c /etc/default/locale']
    const result = parseDpkgVerify(lines)
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ flags: '??5......', isConffile: true, path: '/etc/default/locale' })
  })

  test('non-conffile entry', () => {
    const lines = ['..5......   /usr/bin/something']
    const result = parseDpkgVerify(lines)
    expect(result).toHaveLength(1)
    expect(result[0]?.isConffile).toBe(false)
  })

  test('skips malformed lines', () => {
    const lines = ['garbage', '', '??5...... c /etc/foo']
    expect(parseDpkgVerify(lines)).toHaveLength(1)
  })

  test('empty input', () => {
    expect(parseDpkgVerify([])).toEqual([])
  })
})

describe('diffArrays', () => {
  test('items in after but not before are added', () => {
    const { added, removed } = diffArrays(['a', 'b'], ['a', 'b', 'c'])
    expect(added).toEqual(['c'])
    expect(removed).toEqual([])
  })

  test('items in before but not after are removed', () => {
    const { added, removed } = diffArrays(['a', 'b', 'c'], ['a', 'c'])
    expect(added).toEqual([])
    expect(removed).toEqual(['b'])
  })

  test('both empty', () => {
    const { added, removed } = diffArrays([], [])
    expect(added).toEqual([])
    expect(removed).toEqual([])
  })

  test('completely different', () => {
    const { added, removed } = diffArrays(['a', 'b'], ['c', 'd'])
    expect(added).toEqual(['c', 'd'])
    expect(removed).toEqual(['a', 'b'])
  })
})
