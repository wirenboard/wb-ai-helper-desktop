import { describe, test, expect } from 'bun:test'
import {
  pickTimeFormat, emptySvg, groupByUnits, buildLabelMap, flatten, legendCfg,
} from '../src/server/history-chart.ts'
import type { HistorySeries } from '../src/server/tools.ts'

function series(label: string, units?: string, points = [{ t: 1000, v: 10 }], min = 0, max = 100): HistorySeries {
  return { label, units, points, min, max, avg: (min + max) / 2 }
}

describe('pickTimeFormat', () => {
  test('<= 1h → H:M:S', () => expect(pickTimeFormat(3600)).toBe('%H:%M:%S'))
  test('<= 24h → H:M', () => expect(pickTimeFormat(86400)).toBe('%H:%M'))
  test('<= 7d → d.m H:M', () => expect(pickTimeFormat(7 * 86400)).toBe('%d.%m %H:%M'))
  test('> 7d → d.m', () => expect(pickTimeFormat(8 * 86400)).toBe('%d.%m'))
})

describe('emptySvg', () => {
  test('returns SVG with message', () => {
    const svg = emptySvg('No data')
    expect(svg).toContain('<svg')
    expect(svg).toContain('No data')
    expect(svg).toContain('</svg>')
  })
})

describe('groupByUnits', () => {
  test('groups by units field', () => {
    const groups = groupByUnits([series('a', '°C'), series('b', '°C'), series('c', '%')])
    expect(groups.get('°C')).toHaveLength(2)
    expect(groups.get('%')).toHaveLength(1)
  })

  test('missing units → empty string key', () => {
    const groups = groupByUnits([series('a')])
    expect(groups.has('')).toBe(true)
  })

  test('single unit → one group', () => {
    const groups = groupByUnits([series('a', 'V'), series('b', 'V')])
    expect(groups.size).toBe(1)
  })
})

describe('buildLabelMap', () => {
  test('single device strips device prefix', () => {
    const s1 = series('device1/temp')
    const s2 = series('device1/humidity')
    const map = buildLabelMap([s1, s2])
    expect(map.get(s1)).toBe('temp')
    expect(map.get(s2)).toBe('humidity')
  })

  test('multiple devices keeps full labels', () => {
    const s1 = series('dev1/temp')
    const s2 = series('dev2/temp')
    const map = buildLabelMap([s1, s2])
    expect(map.get(s1)).toBe('dev1/temp')
    expect(map.get(s2)).toBe('dev2/temp')
  })

  test('appends unit to label', () => {
    const s1 = series('dev/temp', '°C')
    const map = buildLabelMap([s1])
    expect(map.get(s1)).toBe('temp, °C')
  })
})

describe('flatten', () => {
  test('converts points to FlatPoint', () => {
    const s = series('dev/temp', '°C', [{ t: 1000, v: 50 }], 0, 100)
    const labels = new Map([[s, 'temp, °C']])
    const flat = flatten([s], labels)
    expect(flat).toHaveLength(1)
    expect(flat[0]?.v).toBe(50)
    expect(flat[0]?.vn).toBe(0.5) // (50-0)/(100-0)
    expect(flat[0]?.series).toBe('temp, °C')
  })

  test('normalizes: min→0, max→1', () => {
    const s = series('x', undefined, [{ t: 1, v: 10 }, { t: 2, v: 20 }], 10, 20)
    const labels = new Map([[s, 'x']])
    const flat = flatten([s], labels)
    expect(flat[0]?.vn).toBe(0) // min
    expect(flat[1]?.vn).toBe(1) // max
  })

  test('zero range → 0.5', () => {
    const s = series('x', undefined, [{ t: 1, v: 5 }], 5, 5)
    const labels = new Map([[s, 'x']])
    expect(flatten([s], labels)[0]?.vn).toBe(0.5)
  })
})

describe('legendCfg', () => {
  test('1 series → null', () => expect(legendCfg(1)).toBeNull())
  test('2-3 → horizontal bottom', () => {
    const cfg = legendCfg(2)
    expect(cfg?.orient).toBe('bottom')
    expect(cfg?.direction).toBe('horizontal')
  })
  test('4+ → vertical right', () => {
    const cfg = legendCfg(5)
    expect(cfg?.orient).toBe('right')
    expect(cfg?.direction).toBe('vertical')
  })
})
