import { describe, test, expect } from 'bun:test'
import { fmtCost, fmtTok, fmtTime, fmtSize, plural } from '../src/web/utils.ts'

describe('fmtCost', () => {
  // USD
  test('USD tiny (< $0.001)', () => {
    expect(fmtCost({ value: 0.0001, currency: 'USD' })).toBe('< $0.001')
  })

  test('USD small (< $0.01)', () => {
    expect(fmtCost({ value: 0.005, currency: 'USD' })).toBe('$0.005')
  })

  test('USD normal', () => {
    expect(fmtCost({ value: 1.234, currency: 'USD' })).toBe('$1.23')
  })

  // RUB
  test('RUB tiny (< 0.01)', () => {
    expect(fmtCost({ value: 0.001, currency: 'RUB' })).toBe('< 0.01 ₽')
  })

  test('RUB under 1', () => {
    expect(fmtCost({ value: 0.55, currency: 'RUB' })).toBe('0.55 ₽')
  })

  test('RUB 1-99', () => {
    expect(fmtCost({ value: 42.7, currency: 'RUB' })).toBe('42.70 ₽')
  })

  test('RUB >= 100 integer', () => {
    expect(fmtCost({ value: 1234.5, currency: 'RUB' })).toBe('1235 ₽')
  })

  // backwards-compat
  test('bare number defaults to USD', () => {
    expect(fmtCost(0.05)).toBe('$0.05')
  })
})

describe('fmtTok', () => {
  test('< 1000 raw', () => {
    expect(fmtTok(500)).toBe('500')
  })

  test('thousands', () => {
    expect(fmtTok(1500)).toBe('1.5k')
  })

  test('millions', () => {
    expect(fmtTok(2_500_000)).toBe('2.5M')
  })

  test('exact 1000', () => {
    expect(fmtTok(1000)).toBe('1.0k')
  })
})

describe('fmtTime', () => {
  test('undefined returns empty', () => {
    expect(fmtTime(undefined)).toBe('')
  })

  test('0 returns empty', () => {
    expect(fmtTime(0)).toBe('')
  })

  test('same day returns HH:MM', () => {
    const now = new Date()
    now.setHours(14, 30, 0, 0)
    expect(fmtTime(now.getTime())).toBe('14:30')
  })

  test('different day returns DD.MM HH:MM', () => {
    // Use a date far in the past
    const d = new Date(2020, 0, 5, 9, 5) // Jan 5, 2020 09:05
    expect(fmtTime(d.getTime())).toBe('05.01 09:05')
  })
})

describe('fmtSize', () => {
  test('bytes', () => {
    expect(fmtSize(512)).toBe('512 Б')
  })

  test('kilobytes', () => {
    expect(fmtSize(1536)).toBe('1.5 КБ')
  })

  test('megabytes', () => {
    expect(fmtSize(2 * 1024 * 1024)).toBe('2.0 МБ')
  })

  test('exact 1024 → KB', () => {
    expect(fmtSize(1024)).toBe('1.0 КБ')
  })
})

describe('plural (Russian grammar)', () => {
  test('1 → first form', () => {
    expect(plural(1, ['файл', 'файла', 'файлов'])).toBe('файл')
  })

  test('2,3,4 → second form', () => {
    expect(plural(2, ['файл', 'файла', 'файлов'])).toBe('файла')
    expect(plural(3, ['файл', 'файла', 'файлов'])).toBe('файла')
    expect(plural(4, ['файл', 'файла', 'файлов'])).toBe('файла')
  })

  test('5-20 → third form', () => {
    for (const n of [5, 6, 10, 11, 12, 15, 19, 20]) {
      expect(plural(n, ['файл', 'файла', 'файлов'])).toBe('файлов')
    }
  })

  test('21 → first form', () => {
    expect(plural(21, ['файл', 'файла', 'файлов'])).toBe('файл')
  })

  test('22 → second form', () => {
    expect(plural(22, ['файл', 'файла', 'файлов'])).toBe('файла')
  })

  test('111 → third form (11-exception)', () => {
    expect(plural(111, ['файл', 'файла', 'файлов'])).toBe('файлов')
  })
})
