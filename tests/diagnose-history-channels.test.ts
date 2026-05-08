import { describe, test, expect } from 'bun:test'
import { diagnoseHistoryChannels } from '../src/server/tools.ts'

describe('diagnoseHistoryChannels', () => {
  test('all channels valid → null', () => {
    const r = diagnoseHistoryChannels(
      [['hwmon', 'CPU Temperature'], ['hwmon', 'Board Temperature']],
      new Map([['hwmon', ['CPU Temperature', 'Board Temperature', 'GPU Temperature']]])
    )
    expect(r).toBeNull()
  })

  test('device not found → mentions device, no list', () => {
    const r = diagnoseHistoryChannels(
      [['wb-system', 'CPU Temperature']],
      new Map([['wb-system', []]])
    )
    expect(r).toContain('"wb-system" не найден')
    expect(r).toContain('mqtt_list_topics')
    expect(r).not.toContain('Доступные')
  })

  test('device missing from map = treated as not found', () => {
    const r = diagnoseHistoryChannels(
      [['ghost', 'X']],
      new Map()
    )
    expect(r).toContain('"ghost" не найден')
  })

  test('control not found on existing device → lists available controls of that device only', () => {
    const r = diagnoseHistoryChannels(
      [['hwmon', 'CPU']],
      new Map([['hwmon', ['CPU Temperature', 'Board Temperature']]])
    )
    expect(r).toContain('"hwmon"')
    expect(r).toContain('[CPU]')
    expect(r).toContain('CPU Temperature')
    expect(r).toContain('Board Temperature')
  })

  test('multiple problems aggregated with separator', () => {
    const r = diagnoseHistoryChannels(
      [['ghost', 'X'], ['hwmon', 'CPU']],
      new Map([['hwmon', ['CPU Temperature']]])
    )
    expect(r).toContain('"ghost" не найден')
    expect(r).toContain('"hwmon"')
    expect(r).toContain(' | ')
  })

  test('duplicate channels deduped in error', () => {
    const r = diagnoseHistoryChannels(
      [['hwmon', 'X'], ['hwmon', 'X']],
      new Map([['hwmon', ['Y']]])
    )
    expect(r).toMatch(/\[X\]/)
    expect(r).not.toMatch(/\[X, X\]/)
  })

  test('mixed: one device fully valid + one device fully invalid', () => {
    const r = diagnoseHistoryChannels(
      [['hwmon', 'CPU Temperature'], ['ghost', 'X']],
      new Map([
        ['hwmon', ['CPU Temperature']],
        ['ghost', []],
      ])
    )
    expect(r).toContain('"ghost" не найден')
    expect(r).not.toContain('hwmon')
  })

  test('control names with spaces handled correctly', () => {
    const r = diagnoseHistoryChannels(
      [['wb-msw-v4_42', 'Temperature 1']],
      new Map([['wb-msw-v4_42', ['Temperature 1', 'Humidity 1', 'CO2']]])
    )
    expect(r).toBeNull()
  })
})
