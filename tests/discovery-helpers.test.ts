import { describe, test, expect } from 'bun:test'
import {
  parseSn,
  defaultHost,
  parseHostPort,
  isIPv4,
  isLinkLocalIPv6,
  preferredSshHost,
} from '../src/server/discovery.ts'

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

describe('isIPv4', () => {
  test('plain IPv4', () => {
    expect(isIPv4('192.168.1.10')).toBe(true)
  })
  test('IPv6 is not IPv4', () => {
    expect(isIPv4('fe80::1')).toBe(false)
  })
  test('hostname is not IPv4', () => {
    expect(isIPv4('wirenboard-abc.local')).toBe(false)
  })
})

describe('isLinkLocalIPv6', () => {
  test('fe80:: is link-local', () => {
    expect(isLinkLocalIPv6('fe80::a00:27ff:fe12:3456')).toBe(true)
  })
  test('febf:: (upper bound of fe80::/10) is link-local', () => {
    expect(isLinkLocalIPv6('febf::1')).toBe(true)
  })
  test('uppercase FE80 is link-local', () => {
    expect(isLinkLocalIPv6('FE80::1')).toBe(true)
  })
  test('global IPv6 is not link-local', () => {
    expect(isLinkLocalIPv6('2001:db8::1')).toBe(false)
  })
  test('ULA fd00:: is not link-local', () => {
    expect(isLinkLocalIPv6('fd00::1')).toBe(false)
  })
})

describe('preferredSshHost', () => {
  test('prefers IPv4 even when a link-local IPv6 comes first', () => {
    expect(preferredSshHost(['fe80::1', '192.168.1.10'], 'wirenboard-abc.local')).toBe('192.168.1.10')
  })

  test('IPv6-only link-local → falls back to the hostname', () => {
    expect(preferredSshHost(['fe80::a00:27ff:fe12:3456'], 'wirenboard-abc.local')).toBe('wirenboard-abc.local')
  })

  test('global IPv6 (no IPv4) is used over the hostname', () => {
    expect(preferredSshHost(['2001:db8::5'], 'wirenboard-abc.local')).toBe('2001:db8::5')
  })

  test('no addresses → hostname', () => {
    expect(preferredSshHost([], 'wirenboard-abc.local')).toBe('wirenboard-abc.local')
  })

  test('link-local only and host is itself an IP → returns the link-local as last resort', () => {
    // host is a bare IP (not a resolvable name), so the link-local is all we have
    expect(preferredSshHost(['fe80::1'], '192.168.1.10')).toBe('192.168.1.10')
  })

  test('IPv4 host with no resolved addresses → the IPv4 host', () => {
    expect(preferredSshHost([], '192.168.1.10')).toBe('192.168.1.10')
  })
})
