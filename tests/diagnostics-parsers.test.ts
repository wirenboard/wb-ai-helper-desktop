// Unit tests для чистых парсеров diagnostic-tool'ов (network_status,
// cloud_status). Сами tool-handler'ы не тестируем — они дёргают ssh.exec,
// без mock-ssh запустить нельзя; парсеры покрывают всю интересную логику.
import { describe, test, expect } from 'bun:test'
import {
  readMarkedSection,
  normalizeInterface,
  pickDefaultRoute,
  parseNmcliColons,
  parsePingLossPct,
  parseCloudMqttControls,
} from '../src/server/diagnostics-parsers.ts'

describe('readMarkedSection', () => {
  test('returns content between markers', () => {
    const raw = '===A===\nfoo\nbar\n===B===\nbaz\n===C==='
    expect(readMarkedSection(raw, 'A')).toBe('foo\nbar')
    expect(readMarkedSection(raw, 'B')).toBe('baz')
  })

  test('trailing section without next marker returns till end', () => {
    const raw = '===A===\nfoo\n===B===\nbaz qux'
    expect(readMarkedSection(raw, 'B')).toBe('baz qux')
  })

  test('missing label returns empty string', () => {
    expect(readMarkedSection('===A===\nfoo', 'XXX')).toBe('')
  })

  test('empty section returns empty string', () => {
    expect(readMarkedSection('===A===\n===B===\nfoo', 'A')).toBe('')
  })
})

describe('parsePingLossPct', () => {
  test('extracts loss percent from `ping -c1` output', () => {
    const raw =
      '64 bytes from 8.8.8.8: icmp_seq=1 ttl=115 time=12.4 ms\n' +
      '\n' +
      '--- 8.8.8.8 ping statistics ---\n' +
      '1 packets transmitted, 1 received, 0% packet loss, time 0ms'
    expect(parsePingLossPct(raw)).toBe(0)
  })

  test('extracts 100% on unreachable host', () => {
    const raw =
      '--- foo.invalid ping statistics ---\n' +
      '1 packets transmitted, 0 received, 100% packet loss, time 0ms'
    expect(parsePingLossPct(raw)).toBe(100)
  })

  test('returns null when no statistics line', () => {
    expect(parsePingLossPct('connect: Network is unreachable')).toBeNull()
  })
})

describe('normalizeInterface', () => {
  test('extracts ifname/operstate/mtu/ipv4', () => {
    const raw = {
      ifname: 'eth0',
      operstate: 'UP',
      mtu: 1500,
      addr_info: [{ local: '192.168.1.50', prefixlen: 24 }],
    }
    expect(normalizeInterface(raw)).toEqual({
      name: 'eth0',
      state: 'UP',
      mtu: 1500,
      ipv4: ['192.168.1.50/24'],
    })
  })

  test('multiple addresses', () => {
    const raw = {
      ifname: 'eth0',
      operstate: 'UP',
      mtu: 1500,
      addr_info: [
        { local: '10.0.0.1', prefixlen: 8 },
        { local: '192.168.1.50', prefixlen: 24 },
      ],
    }
    expect(normalizeInterface(raw).ipv4).toEqual(['10.0.0.1/8', '192.168.1.50/24'])
  })

  test('handles missing fields gracefully', () => {
    expect(normalizeInterface({})).toEqual({ name: '', state: '', mtu: null, ipv4: [] })
    expect(normalizeInterface(null)).toEqual({ name: '', state: '', mtu: null, ipv4: [] })
  })

  test('skips malformed addr_info entries', () => {
    const raw = {
      ifname: 'eth0',
      operstate: 'UP',
      mtu: 1500,
      addr_info: [{ local: '10.0.0.1', prefixlen: 24 }, {}, { broken: true }],
    }
    expect(normalizeInterface(raw).ipv4).toEqual(['10.0.0.1/24'])
  })
})

describe('pickDefaultRoute', () => {
  test('extracts gateway+dev from first route', () => {
    const raw = [{ dst: 'default', gateway: '192.168.1.1', dev: 'eth0' }]
    expect(pickDefaultRoute(raw)).toEqual({ gateway: '192.168.1.1', dev: 'eth0' })
  })

  test('returns null on empty array', () => {
    expect(pickDefaultRoute([])).toBeNull()
  })

  test('returns null when not array', () => {
    expect(pickDefaultRoute(null)).toBeNull()
    expect(pickDefaultRoute({})).toBeNull()
  })

  test('returns null when route lacks gateway/dev', () => {
    expect(pickDefaultRoute([{ dst: 'default' }])).toBeNull()
  })
})

describe('parseNmcliColons', () => {
  test('parses `nmcli -t -f NAME,UUID,TYPE,DEVICE,STATE connection show` output', () => {
    const raw =
      'eth0:uuid-1:802-3-ethernet:eth0:activated\n' +
      'wifi-home:uuid-2:802-11-wireless:wlan0:activated'
    const fields = ['name', 'uuid', 'type', 'device', 'state'] as const
    expect(parseNmcliColons(raw, fields)).toEqual([
      { name: 'eth0', uuid: 'uuid-1', type: '802-3-ethernet', device: 'eth0', state: 'activated' },
      { name: 'wifi-home', uuid: 'uuid-2', type: '802-11-wireless', device: 'wlan0', state: 'activated' },
    ])
  })

  test('handles missing trailing fields as empty strings', () => {
    const raw = 'eth0:uuid-1:802-3-ethernet'
    expect(parseNmcliColons(raw, ['name', 'uuid', 'type', 'device'] as const)).toEqual([
      { name: 'eth0', uuid: 'uuid-1', type: '802-3-ethernet', device: '' },
    ])
  })

  test('skips empty lines', () => {
    const raw = 'eth0:uuid:t:d\n\n\nwlan0:uuid2:t2:d2'
    expect(parseNmcliColons(raw, ['name', 'uuid', 'type', 'device'] as const)).toHaveLength(2)
  })

  test('empty input → empty array', () => {
    expect(parseNmcliColons('', ['a', 'b'] as const)).toEqual([])
  })
})

describe('parseCloudMqttControls', () => {
  test('groups topics by provider, drops meta', () => {
    const raw =
      '/devices/system__wb-cloud-agent__cloud_main/controls/status\tactive\n' +
      '/devices/system__wb-cloud-agent__cloud_main/controls/activation_link\thttps://x/y\n' +
      '/devices/system__wb-cloud-agent__cloud_main/controls/status/meta\tordered\n' +
      '/devices/system__wb-cloud-agent__custom/controls/status\tinactive'
    expect(parseCloudMqttControls(raw)).toEqual({
      'system__wb-cloud-agent__cloud_main': {
        status: 'active',
        activation_link: 'https://x/y',
      },
      'system__wb-cloud-agent__custom': {
        status: 'inactive',
      },
    })
  })

  test('ignores topics that do not match cloud-agent pattern', () => {
    const raw =
      '/devices/wb-mqtt-serial/controls/uptime\t12345\n' +
      '/devices/system__wb-cloud-agent__cloud_main/controls/status\tactive'
    const out = parseCloudMqttControls(raw)
    expect(Object.keys(out)).toEqual(['system__wb-cloud-agent__cloud_main'])
  })

  test('empty input → empty object', () => {
    expect(parseCloudMqttControls('')).toEqual({})
  })

  test('lines without TAB are skipped', () => {
    const raw = 'broken-line-no-tab\n/devices/system__wb-cloud-agent__x/controls/status\tactive'
    expect(parseCloudMqttControls(raw)).toEqual({
      'system__wb-cloud-agent__x': { status: 'active' },
    })
  })
})
