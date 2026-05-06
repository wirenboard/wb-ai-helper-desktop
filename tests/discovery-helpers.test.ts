import { describe, test, expect } from 'bun:test'
import { parseSn, defaultHost } from '../src/server/discovery.ts'

describe('parseSn', () => {
  test('standard hostname', () => {
    expect(parseSn('wirenboard-a25ndemj.local')).toBe('A25NDEMJ')
  })

  test('uppercase input normalized to upper', () => {
    expect(parseSn('wirenboard-ABC123.local')).toBe('ABC123')
  })

  test('without .local', () => {
    expect(parseSn('wirenboard-abc123')).toBe('ABC123')
  })

  test('trailing dot stripped', () => {
    expect(parseSn('wirenboard-abc123.local.')).toBe('ABC123')
  })

  test('non-wirenboard hostname → null', () => {
    expect(parseSn('not-a-wirenboard.local')).toBeNull()
  })

  test('empty string → null', () => {
    expect(parseSn('')).toBeNull()
  })

  test('random hostname → null', () => {
    expect(parseSn('random-hostname')).toBeNull()
  })
})

describe('defaultHost', () => {
  test('builds correct hostname', () => {
    expect(defaultHost('A25NDEMJ')).toBe('wirenboard-a25ndemj.local')
  })
})
