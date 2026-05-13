import { describe, test, expect } from 'bun:test'
import { parseSn, defaultHost, parseHostPort } from '../src/server/discovery.ts'

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

describe('parseHostPort', () => {
  test('bare IP', () => {
    expect(parseHostPort('192.168.1.10')).toEqual({ host: '192.168.1.10' })
  })

  test('IP with port', () => {
    expect(parseHostPort('192.168.1.10:2222')).toEqual({ host: '192.168.1.10', port: 2222 })
  })

  test('hostname with port', () => {
    expect(parseHostPort('wirenboard-abc.local:8022')).toEqual({ host: 'wirenboard-abc.local', port: 8022 })
  })

  test('whitespace trimmed', () => {
    expect(parseHostPort('  10.0.0.1:22  ')).toEqual({ host: '10.0.0.1', port: 22 })
  })

  test('invalid port stays in host', () => {
    expect(parseHostPort('host:abc')).toEqual({ host: 'host:abc' })
  })

  test('out-of-range port stays in host', () => {
    expect(parseHostPort('host:70000')).toEqual({ host: 'host:70000' })
  })

  test('zero port stays in host', () => {
    expect(parseHostPort('host:0')).toEqual({ host: 'host:0' })
  })

  test('IPv6-like (multiple colons) returned as-is', () => {
    expect(parseHostPort('::1:8080')).toEqual({ host: '::1:8080' })
  })
})
