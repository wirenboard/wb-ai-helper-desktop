// Unit-тесты на парсеры/форматтеры шаблонов wb-mqtt-serial. Сами tool-handler'ы
// ходят через mqttRpc + readFile — без mock'а MQTT не запустить, парсеры
// покрывают всю интересную логику.
import { describe, test, expect } from 'bun:test'
import {
  parseTemplatesList,
  filterTemplates,
  summarizeByGroup,
  filterChannels,
  renderTemplate,
  buildLoadConfigParams,
  enrichSerialRpcError,
} from '../src/server/modbus-templates.ts'

describe('parseTemplatesList', () => {
  test('flattens groups → flat array', () => {
    const load = {
      types: [
        {
          name: 'Реле и диммеры',
          types: [
            { type: 'WB-MR6C', 'mqtt-id': 'wb-mr6c', name: 'WB-MR6C v.2', deprecated: false },
            { type: 'WB-MDM3', 'mqtt-id': 'wb-mdm3', name: 'WB-MDM3', deprecated: false },
          ],
        },
        {
          name: 'Аналоговые входы',
          types: [
            { type: 'WB-MAI6', 'mqtt-id': 'wb-mai6', name: 'WB-MAI6 v.2', deprecated: false },
          ],
        },
      ],
    }
    const out = parseTemplatesList(load)
    expect(out).toHaveLength(3)
    expect(out[0]).toEqual({
      type: 'WB-MR6C',
      mqttId: 'wb-mr6c',
      name: 'WB-MR6C v.2',
      deprecated: false,
      group: 'Реле и диммеры',
    })
    expect(out[2]?.group).toBe('Аналоговые входы')
  })

  test('marks deprecated correctly', () => {
    const out = parseTemplatesList({
      types: [
        {
          name: 'Old',
          types: [
            { type: 'WB-MR3-OLD', 'mqtt-id': 'wb-mr3-old', name: 'WB-MR3 (deprecated)', deprecated: true },
          ],
        },
      ],
    })
    expect(out[0]?.deprecated).toBe(true)
  })

  test('falls back to type.toLowerCase() when mqtt-id missing', () => {
    const out = parseTemplatesList({
      types: [
        {
          name: 'X',
          types: [{ type: 'WB-LEGACY-NO-MQTT-ID', name: 'legacy' }],
        },
      ],
    })
    expect(out[0]?.mqttId).toBe('wb-legacy-no-mqtt-id')
  })

  test('skips entries without `type`', () => {
    const out = parseTemplatesList({
      types: [
        {
          name: 'X',
          types: [{ name: 'no-type-here' }, { type: 'OK' }],
        },
      ],
    })
    expect(out).toHaveLength(1)
    expect(out[0]?.type).toBe('OK')
  })

  test('empty input → empty array', () => {
    expect(parseTemplatesList({})).toEqual([])
    expect(parseTemplatesList({ types: [] })).toEqual([])
  })
})

describe('filterTemplates', () => {
  const list = [
    { type: 'WB-MR6C', mqttId: 'wb-mr6c', name: '6-channel relay', deprecated: false, group: 'Реле' },
    { type: 'WB-MDM3', mqttId: 'wb-mdm3', name: 'Dimmer 3-ch', deprecated: false, group: 'Реле' },
    { type: 'WB-MAI6', mqttId: 'wb-mai6', name: 'Analog input 6ch', deprecated: false, group: 'AI' },
  ]

  test('substring on type', () => {
    expect(filterTemplates(list, 'mr6').map((t) => t.type)).toEqual(['WB-MR6C'])
  })

  test('substring on mqttId', () => {
    expect(filterTemplates(list, 'mdm').map((t) => t.type)).toEqual(['WB-MDM3'])
  })

  test('substring on name', () => {
    expect(filterTemplates(list, 'analog').map((t) => t.type)).toEqual(['WB-MAI6'])
  })

  test('case-insensitive', () => {
    expect(filterTemplates(list, 'WB-MR').length).toBe(1)
    expect(filterTemplates(list, 'wb-mr').length).toBe(1)
  })

  test('empty filter → return all', () => {
    expect(filterTemplates(list, '')).toEqual(list)
    expect(filterTemplates(list, '   ')).toEqual(list)
  })

  test('no match → empty', () => {
    expect(filterTemplates(list, 'nonexistent')).toEqual([])
  })
})

describe('summarizeByGroup', () => {
  test('counts per group, marks deprecated separately', () => {
    const list = [
      { type: 'A', mqttId: 'a', name: 'a', deprecated: false, group: 'G1' },
      { type: 'B', mqttId: 'b', name: 'b', deprecated: false, group: 'G1' },
      { type: 'C', mqttId: 'c', name: 'c', deprecated: true, group: 'G1' },
      { type: 'D', mqttId: 'd', name: 'd', deprecated: false, group: 'G2' },
    ]
    expect(summarizeByGroup(list)).toEqual({
      G1: { count: 3, deprecated: 1 },
      G2: { count: 1, deprecated: 0 },
    })
  })

  test('empty input → empty object', () => {
    expect(summarizeByGroup([])).toEqual({})
  })
})

describe('filterChannels', () => {
  const channels = [
    { name: 'K1', enabled: true, reg_type: 'coil' },
    { name: 'K2', enabled: false, reg_type: 'coil' },
    { name: 'Uptime', enabled: true, reg_type: 'input' },
  ]

  test('enabledOnly filters out disabled', () => {
    const out = filterChannels(channels, { enabledOnly: true })
    expect(out.map((c) => c.name)).toEqual(['K1', 'Uptime'])
  })

  test('channelFilter substring case-insensitive', () => {
    expect(filterChannels(channels, { channelFilter: 'k' }).map((c) => c.name)).toEqual(['K1', 'K2'])
    expect(filterChannels(channels, { channelFilter: 'TIME' }).map((c) => c.name)).toEqual(['Uptime'])
  })

  test('combined enabledOnly + channelFilter', () => {
    const out = filterChannels(channels, { enabledOnly: true, channelFilter: 'k' })
    expect(out.map((c) => c.name)).toEqual(['K1'])
  })

  test('no opts → return all', () => {
    expect(filterChannels(channels, {})).toEqual(channels)
  })
})

describe('renderTemplate', () => {
  const tmpl = {
    device_type: 'WB-MR6C',
    title: '6-channel relay',
    device: {
      name: 'WB-MR6C',
      id: 'wb-mr6c',
      channels: [
        { name: 'K1', reg_type: 'coil', address: 0, format: 'u8', type: 'switch' },
        { name: 'K2', reg_type: 'coil', address: 1, type: 'switch' },
        { name: 'Uptime', reg_type: 'input', address: 104, format: 'u32', type: 'value', units: 's', enabled: false },
      ],
      parameters: { in1_mode: { type: 'enum' }, in2_mode: { type: 'enum' } },
      groups: [],
    },
  }

  test('summary (default)', () => {
    const out = renderTemplate(tmpl)
    expect(out['device_type']).toBe('WB-MR6C')
    expect(out['title']).toBe('6-channel relay')
    expect(out['parametersCount']).toBe(2)
    expect(out['channelCount']).toBe(3)
    expect(Array.isArray(out['channels'])).toBe(true)
    const chs = out['channels'] as any[]
    expect(chs[0]).toEqual({ name: 'K1', reg_type: 'coil', address: 0, format: 'u8', type: 'switch' })
    // disabled flag сохраняется в summary
    expect(chs[2]).toMatchObject({ name: 'Uptime', enabled: false })
  })

  test('full — возвращает шаблон как есть', () => {
    const out = renderTemplate(tmpl, { view: 'full' })
    expect(out).toEqual(tmpl as unknown as Record<string, unknown>)
  })

  test('full + filter — channels отфильтрованы, но остальное на месте', () => {
    const out = renderTemplate(tmpl, { view: 'full', enabledOnly: true })
    const dev = (out as any).device
    expect(dev.channels.map((c: any) => c.name)).toEqual(['K1', 'K2'])
    expect(dev.parameters).toEqual(tmpl.device.parameters)
    // Не мутируем исходник
    expect(tmpl.device.channels).toHaveLength(3)
  })

  test('channels-only — только список каналов', () => {
    const out = renderTemplate(tmpl, { view: 'channels-only' })
    expect(Object.keys(out).sort()).toEqual(['channelCount', 'channels', 'totalChannelCount'])
  })

  test('meta-only — без channels', () => {
    const out = renderTemplate(tmpl, { view: 'meta-only' })
    expect(out).not.toHaveProperty('channels')
    expect(out['device_type']).toBe('WB-MR6C')
    expect(out['parametersCount']).toBe(2)
    expect(out['totalChannelCount']).toBe(3)
  })

  test('enabledOnly применяется во всех views (кроме full без фильтра)', () => {
    expect((renderTemplate(tmpl, { enabledOnly: true })['channels'] as any[]).length).toBe(2)
    expect((renderTemplate(tmpl, { view: 'channels-only', enabledOnly: true })['channels'] as any[]).length).toBe(2)
    expect(renderTemplate(tmpl, { view: 'meta-only', enabledOnly: true })['channelCount']).toBe(2)
  })

  test('channelFilter работает', () => {
    const out = renderTemplate(tmpl, { channelFilter: 'time' })
    expect((out['channels'] as any[]).map((c) => c.name)).toEqual(['Uptime'])
  })

  test('handles missing device gracefully', () => {
    const out = renderTemplate({ device_type: 'X' })
    expect(out['device_type']).toBe('X')
    expect(out['channelCount']).toBe(0)
    expect(out['channels']).toEqual([])
  })
})

describe('buildLoadConfigParams', () => {
  test('device_id задан → возвращает {device_id} и игнорирует прочее', () => {
    expect(
      buildLoadConfigParams({ device_id: 'wb-mr6c_138', path: '/dev/x', slave_id: 5 }),
    ).toEqual({ device_id: 'wb-mr6c_138' })
  })

  test('без device_id, есть path + slave_id → возвращает с modbus-дефолтами 8/N/2/9600', () => {
    expect(
      buildLoadConfigParams({ path: '/dev/ttyRS485-1', slave_id: 138 }),
    ).toEqual({
      path: '/dev/ttyRS485-1',
      slave_id: 138,
      baud_rate: 9600,
      parity: 'N',
      data_bits: 8,
      stop_bits: 2,
    })
  })

  test('без device_id, без path → null', () => {
    expect(buildLoadConfigParams({ slave_id: 138 })).toBeNull()
  })

  test('без device_id, без slave_id → null', () => {
    expect(buildLoadConfigParams({ path: '/dev/x' })).toBeNull()
  })

  test('явные serial-параметры перебивают дефолты', () => {
    const out = buildLoadConfigParams({
      path: '/dev/ttyRS485-1',
      slave_id: 138,
      device_type: 'WB-MR6C',
      baud_rate: 115200,
      parity: 'E',
      data_bits: 7,
      stop_bits: 1,
    })
    expect(out).toEqual({
      path: '/dev/ttyRS485-1',
      slave_id: 138,
      device_type: 'WB-MR6C',
      baud_rate: 115200,
      parity: 'E',
      data_bits: 7,
      stop_bits: 1,
    })
  })

  test('пустая parity ИЛИ пустой device_type не подставляется (default остаётся N для parity, device_type не попадает)', () => {
    const out = buildLoadConfigParams({
      path: '/dev/x',
      slave_id: 1,
      device_type: '',
      parity: '',
    })
    expect(out).toEqual({
      path: '/dev/x',
      slave_id: 1,
      baud_rate: 9600,
      parity: 'N',
      data_bits: 8,
      stop_bits: 2,
    })
  })

  test('slave_id=0 валиден', () => {
    expect(buildLoadConfigParams({ path: '/dev/x', slave_id: 0 })).toEqual({
      path: '/dev/x',
      slave_id: 0,
      baud_rate: 9600,
      parity: 'N',
      data_bits: 8,
      stop_bits: 2,
    })
  })
})

describe('enrichSerialRpcError', () => {
  test('таймаут → добавляет hint про устаревший wb-mqtt-serial', () => {
    const out = enrichSerialRpcError(new Error('RPC wb-mqtt-serial/device/LoadConfig — нет ответа (таймаут 10с)'), 'LoadConfig')
    expect(out).toContain('таймаут')
    expect(out).toContain('wb-mqtt-serial')
    expect(out).toContain('2.180')
    expect(out).toContain('apt install wb-mqtt-serial')
  })

  test('таймаут (англ) тоже распознаётся', () => {
    const out = enrichSerialRpcError(new Error('mqtt rpc wb-mqtt-serial/device/Probe: timeout (no reply in 15s)'), 'Probe')
    expect(out).toContain('2.180')
  })

  test('не-таймаут оставляет ошибку как есть', () => {
    const out = enrichSerialRpcError(new Error('Port is not defined'), 'LoadConfig')
    expect(out).toBe('Port is not defined')
    expect(out).not.toContain('2.180')
  })

  test('обрабатывает строку и не-Error', () => {
    expect(enrichSerialRpcError('something', 'LoadConfig')).toBe('something')
    expect(enrichSerialRpcError(null, 'LoadConfig')).toBe('null')
  })
})
