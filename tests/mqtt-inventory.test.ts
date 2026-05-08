// Unit tests на парсеры error-флагов и билдер inventory-снимка для tool'а
// `mqtt_inventory`. Сам tool-handler дёргает MqttPool.listTopics — без
// mock'а MQTT-брокера не запустить, парсеры покрывают всю интересную логику.
import { describe, test, expect } from 'bun:test'
import { parseErrorFlags, buildInventory } from '../src/server/mqtt-inventory.ts'

describe('parseErrorFlags', () => {
  test('returns undefined for empty/missing input', () => {
    expect(parseErrorFlags('')).toBeUndefined()
    expect(parseErrorFlags(undefined)).toBeUndefined()
    expect(parseErrorFlags(null)).toBeUndefined()
  })

  test('parses single flag r → read=true, остальное false', () => {
    const f = parseErrorFlags('r')!
    expect(f.read).toBe(true)
    expect(f.write).toBe(false)
    expect(f.periodMiss).toBe(false)
    expect(f.raw).toBe('r')
    expect(f.unknown).toBeUndefined()
  })

  test('parses w → write=true', () => {
    expect(parseErrorFlags('w')).toMatchObject({ read: false, write: true, periodMiss: false })
  })

  test('parses p → periodMiss=true', () => {
    expect(parseErrorFlags('p')).toMatchObject({ read: false, write: false, periodMiss: true })
  })

  test('parses combinations rwp', () => {
    const f = parseErrorFlags('rwp')!
    expect(f.read).toBe(true)
    expect(f.write).toBe(true)
    expect(f.periodMiss).toBe(true)
  })

  test('captures unknown chars in `unknown`, известные всё равно ставит', () => {
    const f = parseErrorFlags('rxyz')!
    expect(f.read).toBe(true)
    expect(f.unknown).toBe('xyz')
  })
})

describe('buildInventory', () => {
  test('empty topics → empty inventory', () => {
    expect(buildInventory([])).toEqual({ count: 0, errorCount: 0, errors: [], devices: [] })
  })

  test('single device with one control + meta and value', () => {
    const topics: Array<[string, string]> = [
      ['/devices/wb-mr6c_2/meta/name', 'WB-MR6C 2'],
      ['/devices/wb-mr6c_2/meta/driver', 'wb-mqtt-serial'],
      ['/devices/wb-mr6c_2/controls/K1', '0'],
      ['/devices/wb-mr6c_2/controls/K1/meta/type', 'switch'],
      ['/devices/wb-mr6c_2/controls/K1/meta/order', '1'],
    ]
    const inv = buildInventory(topics)
    expect(inv.count).toBe(1)
    expect(inv.devices[0]).toMatchObject({ id: 'wb-mr6c_2', name: 'WB-MR6C 2', driver: 'wb-mqtt-serial' })
    expect(inv.devices[0]!.controls).toEqual([
      { name: 'K1', value: '0', type: 'switch', order: 1 },
    ])
  })

  test('controls sorted by order, ties broken alphabetically', () => {
    const topics: Array<[string, string]> = [
      ['/devices/dev/controls/B/meta/order', '2'],
      ['/devices/dev/controls/B', '0'],
      ['/devices/dev/controls/A/meta/order', '1'],
      ['/devices/dev/controls/A', '0'],
      ['/devices/dev/controls/Z', '0'], // без order → 999
      ['/devices/dev/controls/Y', '0'], // без order → 999
    ]
    const inv = buildInventory(topics)
    const names = inv.devices[0]!.controls.map((c) => c.name)
    expect(names).toEqual(['A', 'B', 'Y', 'Z'])
  })

  test('error flag on a control surfaces in `errors`, value = last-known-good', () => {
    const topics: Array<[string, string]> = [
      ['/devices/sensor/meta/name', 'Temperature sensor'],
      ['/devices/sensor/controls/Temp', '23.5'],
      ['/devices/sensor/controls/Temp/meta/error', 'r'],
      ['/devices/sensor/controls/Temp/meta/units', '°C'],
    ]
    const inv = buildInventory(topics)
    expect(inv.errors).toHaveLength(1)
    expect(inv.errors[0]).toEqual({ device: 'sensor', control: 'Temp', flags: expect.objectContaining({ read: true }) as any })
    // Value сохраняется — это last-known-good per WB Conventions, важная семантика для модели.
    expect(inv.devices[0]!.controls[0]!.value).toBe('23.5')
  })

  test('device-level error также попадает в errors', () => {
    const topics: Array<[string, string]> = [
      ['/devices/d/meta/name', 'X'],
      ['/devices/d/meta/error', 'p'],
      ['/devices/d/controls/c1', 'v'],
    ]
    const inv = buildInventory(topics)
    expect(inv.errors).toContainEqual({
      device: 'd',
      flags: expect.objectContaining({ periodMiss: true }) as any,
    })
  })

  test('full /meta JSON parsing for control', () => {
    const topics: Array<[string, string]> = [
      ['/devices/d/meta/name', 'X'],
      ['/devices/d/controls/c1', '42'],
      ['/devices/d/controls/c1/meta', JSON.stringify({ type: 'value', units: 'A', readonly: true, order: 5, min: 0, max: 100, error: 'w' })],
    ]
    const inv = buildInventory(topics)
    const c = inv.devices[0]!.controls[0]!
    expect(c.type).toBe('value')
    expect(c.units).toBe('A')
    expect(c.readonly).toBe(true)
    expect(c.order).toBe(5)
    expect(c.min).toBe(0)
    expect(c.max).toBe(100)
    expect(c.error?.write).toBe(true)
  })

  test('includeMeta=true прикладывает raw meta-объект к контролу', () => {
    const meta = { type: 'value', custom_field: 'foo' }
    const topics: Array<[string, string]> = [
      ['/devices/d/controls/c1/meta', JSON.stringify(meta)],
    ]
    const inv = buildInventory(topics, { includeMeta: true, includeEmpty: true })
    expect(inv.devices[0]!.controls[0]!.meta).toEqual(meta)
  })

  test('includeMeta=false не прикладывает (по умолчанию)', () => {
    const topics: Array<[string, string]> = [
      ['/devices/d/controls/c1/meta', JSON.stringify({ type: 'value' })],
    ]
    const inv = buildInventory(topics, { includeEmpty: true })
    expect(inv.devices[0]!.controls[0]!.meta).toBeUndefined()
  })

  test('filter by device substring, case-insensitive', () => {
    const topics: Array<[string, string]> = [
      ['/devices/wb-mr6c_2/controls/K1', '0'],
      ['/devices/wb-mai6_3/controls/A1', '0'],
      ['/devices/sensor_42/controls/Temp', '0'],
    ]
    const inv = buildInventory(topics, { filter: 'WB-MR6C' })
    expect(inv.devices.map((d) => d.id)).toEqual(['wb-mr6c_2'])
  })

  test('includeEmpty=false (default) hides device with только meta', () => {
    const topics: Array<[string, string]> = [
      ['/devices/orphan/meta/name', 'Has no controls'],
      ['/devices/normal/controls/v', '1'],
    ]
    expect(buildInventory(topics).devices.map((d) => d.id)).toEqual(['normal'])
  })

  test('includeEmpty=true показывает пустые', () => {
    const topics: Array<[string, string]> = [
      ['/devices/orphan/meta/name', 'Has no controls'],
      ['/devices/normal/controls/v', '1'],
    ]
    const ids = buildInventory(topics, { includeEmpty: true }).devices.map((d) => d.id)
    expect(ids.sort()).toEqual(['normal', 'orphan'])
  })

  test('controls with spaces in name работают (типичный случай WB-MR6C: "Input 0", "Input 0 counter")', () => {
    const topics: Array<[string, string]> = [
      ['/devices/wb-mr6c_2/controls/Input 0', '1'],
      ['/devices/wb-mr6c_2/controls/Input 0/meta/type', 'switch'],
      ['/devices/wb-mr6c_2/controls/Input 0 counter', '42'],
      ['/devices/wb-mr6c_2/controls/Input 0 counter/meta/type', 'value'],
    ]
    const inv = buildInventory(topics)
    const names = inv.devices[0]!.controls.map((c) => c.name)
    expect(names.sort()).toEqual(['Input 0', 'Input 0 counter'])
  })

  test('malformed topics просто игнорируются (не падает)', () => {
    const topics: Array<[string, string]> = [
      ['not-a-devices-topic', 'whatever'],
      ['/devices/', 'orphan'],
      ['/devices/d/controls/x', 'ok'],
    ]
    const inv = buildInventory(topics)
    expect(inv.devices.map((d) => d.id)).toEqual(['d'])
  })
})
