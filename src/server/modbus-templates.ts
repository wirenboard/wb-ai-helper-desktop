// Парсеры и форматтеры шаблонов wb-mqtt-serial. Вынесены сюда, чтобы
// покрыть unit-тестами без mock'а MQTT — handler'ы в tools.ts вытаскивают
// сырой RPC-ответ и читают файл шаблона, потом гонят через эти функции.

/** Обогатить ошибку RPC `wb-mqtt-serial/device/<method>` диагностической
 *  подсказкой. Конкретно: при таймауте упомянуть, что устаревший драйвер
 *  (< 2.180) этот endpoint может не обслуживать — реальный кейс наблюдался
 *  на wb-mqtt-serial 2.146.0 (актуальная в репе stable wb7 — 2.224+).
 *  Для неустаревших версий ошибка сохраняет исходный смысл (network/bad
 *  params/etc), просто добавляется hint про возможную причину «таймаут».
 */
export function enrichSerialRpcError(e: unknown, method: string): string {
  const raw = e instanceof Error ? e.message : String(e)
  if (/таймаут|timeout/i.test(raw)) {
    return (
      `${raw}. ` +
      `На устаревших версиях wb-mqtt-serial (<2.180) endpoint device/${method} мог быть нерабочим — ` +
      `проверь \`dpkg -l wb-mqtt-serial\`. Если версия меньше 2.180, обнови: \`apt update && apt install wb-mqtt-serial\` ` +
      `(подтверди операцию с пользователем — это перезапустит драйвер).`
    )
  }
  return raw
}

/** Подготовить params для RPC `wb-mqtt-serial/device/LoadConfig`.
 *
 *  Два режима:
 *    1. По `device_id` (имя устройства в MQTT, например "wb-mr6c_138")
 *       — wb-mqtt-serial сам резолвит остальные поля из своего конфига.
 *    2. По явным `{path, slave_id, device_type, baud_rate, parity, data_bits, stop_bits}`
 *       — для случая когда устройство не в конфиге ещё (после bus scan).
 *
 *  Если задан `device_id` — другие поля игнорируются (приоритет).
 *  Если нет `device_id` и нет `path+slave_id` — возвращает null (caller
 *  должен показать ошибку «нужен либо device_id, либо path+slave_id»).
 */
export function buildLoadConfigParams(args: {
  device_id?: string
  path?: string
  slave_id?: number
  device_type?: string
  baud_rate?: number
  parity?: string
  data_bits?: number
  stop_bits?: number
}): Record<string, unknown> | null {
  if (args.device_id) return { device_id: args.device_id }
  if (!args.path || typeof args.slave_id !== 'number') return null
  // Свежие версии wb-mqtt-serial (2.224+) требуют data_bits/parity/stop_bits
  // как обязательные поля — без них RPC отвечает «Missing required property»
  // (валидация JSON-schema). На старых это было опционально. Подставляем
  // безопасные modbus-дефолты (8/N/2) если caller не передал явно — для
  // 99% RS-485 устройств это правильно. baud_rate тоже подставляем (9600
  // — стандартный default из wb-mqtt-serial config).
  const out: Record<string, unknown> = {
    path: args.path,
    slave_id: args.slave_id,
    baud_rate: typeof args.baud_rate === 'number' ? args.baud_rate : 9600,
    // `||` (не `??`) — пустая строка для parity бесполезна, трактуем как «не задано».
    parity: args.parity || 'N',
    data_bits: typeof args.data_bits === 'number' ? args.data_bits : 8,
    stop_bits: typeof args.stop_bits === 'number' ? args.stop_bits : 2,
  }
  if (args.device_type) out['device_type'] = args.device_type
  return out
}

/** Один шаблон в плоском списке (после flatten'а групп Load.types). */
export type TemplateInfo = {
  type: string // device_type из шаблона (e.g. "WB-MR6C")
  mqttId: string // нормализованный id (e.g. "wb-mr6c") — из mqtt-id поля Load.types
  name: string // human-readable название
  deprecated: boolean
  group: string // имя группы (e.g. "Реле и диммеры")
}

type RpcLoadTypes = {
  types?: Array<{
    name: string
    types?: Array<{
      type?: string
      'mqtt-id'?: string
      name?: string
      deprecated?: boolean
    }>
  }>
}

/** Флэттенит результат `wb-mqtt-serial/config/Load.types` в плоский массив
 *  TemplateInfo. Пустые группы пропускает. Если у шаблона нет mqtt-id —
 *  использует device_type в нижнем регистре как fallback (некоторые старые
 *  шаблоны не имеют отдельного mqtt-id поля).
 */
export function parseTemplatesList(load: RpcLoadTypes): TemplateInfo[] {
  const out: TemplateInfo[] = []
  for (const group of load.types ?? []) {
    const groupName = group.name ?? '(без группы)'
    for (const t of group.types ?? []) {
      const type = t.type ?? ''
      if (!type) continue
      const mqttId = t['mqtt-id'] ?? type.toLowerCase()
      out.push({
        type,
        mqttId,
        name: t.name ?? type,
        deprecated: t.deprecated === true,
        group: groupName,
      })
    }
  }
  return out
}

/** Подстрочный фильтр по type/mqttId/name (case-insensitive). Пустая строка
 *  → всё. */
export function filterTemplates(list: TemplateInfo[], filter: string): TemplateInfo[] {
  const f = filter.trim().toLowerCase()
  if (!f) return list
  return list.filter(
    (t) =>
      t.type.toLowerCase().includes(f) ||
      t.mqttId.toLowerCase().includes(f) ||
      t.name.toLowerCase().includes(f),
  )
}

/** Агрегат по группам — `{group: {count, deprecated_count}}`. Используется
 *  в `modbus_templates_list` без фильтра — чтобы не возвращать сразу 250+
 *  записей и не рвать токен-лимит. С фильтром handler возвращает плоский
 *  список matched. */
export function summarizeByGroup(list: TemplateInfo[]): Record<string, { count: number; deprecated: number }> {
  const out: Record<string, { count: number; deprecated: number }> = {}
  for (const t of list) {
    const g = (out[t.group] = out[t.group] ?? { count: 0, deprecated: 0 })
    g.count++
    if (t.deprecated) g.deprecated++
  }
  return out
}

// ── Рендер одного шаблона (содержимое /usr/share/wb-mqtt-serial/templates/…json) ──

type Channel = Record<string, unknown> & {
  name?: string
  reg_type?: string
  address?: number
  format?: string
  type?: string
  units?: string
  enabled?: boolean
}

type Template = Record<string, unknown> & {
  device_type?: string
  title?: string
  device?: {
    name?: string
    id?: string
    channels?: Channel[]
    parameters?: Record<string, unknown>
    groups?: unknown[]
    setup?: unknown[]
  }
}

export type TemplateView = 'summary' | 'full' | 'channels-only' | 'meta-only'

/** Извлекает компактную информацию о канале для view='summary'. */
function channelSummary(c: Channel): Record<string, unknown> {
  const out: Record<string, unknown> = { name: c.name ?? '?' }
  if (c.reg_type) out['reg_type'] = c.reg_type
  if (typeof c.address !== 'undefined') out['address'] = c.address
  if (c.format) out['format'] = c.format
  if (c.type) out['type'] = c.type
  if (c.units) out['units'] = c.units
  if (c.enabled === false) out['enabled'] = false
  return out
}

/** Применить фильтры enabledOnly/channelFilter (case-insensitive substring
 *  по name) к списку channels. */
export function filterChannels(
  channels: Channel[],
  opts: { enabledOnly?: boolean; channelFilter?: string },
): Channel[] {
  let out = channels
  if (opts.enabledOnly) out = out.filter((c) => c.enabled !== false)
  const f = opts.channelFilter?.trim().toLowerCase()
  if (f) out = out.filter((c) => (c.name ?? '').toLowerCase().includes(f))
  return out
}

/** Рендер шаблона в одно из view-представлений. Все view фильтруют каналы
 *  через `filterChannels` (если opts заданы).
 *
 *    - summary (default): {device_type, title, deviceName, deviceId, channelCount, channels: [{name, reg_type, address, format, type, units}]}
 *    - full: весь шаблон как есть
 *    - channels-only: только {channelCount, channels: [...]} (без meta устройства)
 *    - meta-only: только {device_type, title, deviceName, deviceId, parametersCount, channelCount} — без channel'ов и параметров
 */
export function renderTemplate(
  tmpl: Template,
  opts: { view?: TemplateView; enabledOnly?: boolean; channelFilter?: string } = {},
): Record<string, unknown> {
  const view: TemplateView = opts.view ?? 'summary'
  const dev = tmpl.device ?? {}
  const allChannels = Array.isArray(dev.channels) ? dev.channels : []
  const filtered = filterChannels(allChannels, opts)
  const params = (dev.parameters ?? {}) as Record<string, unknown>
  const meta = {
    device_type: tmpl.device_type ?? '',
    title: tmpl.title ?? '',
    deviceName: dev.name ?? '',
    deviceId: dev.id ?? '',
    parametersCount: Object.keys(params).length,
    channelCount: filtered.length,
    totalChannelCount: allChannels.length,
  }
  if (view === 'full') {
    // Полный шаблон, но channels — отфильтрованные (если filter задан)
    if (opts.enabledOnly || opts.channelFilter) {
      const out = JSON.parse(JSON.stringify(tmpl)) as Template
      if (out.device) out.device.channels = filtered
      return out as unknown as Record<string, unknown>
    }
    return tmpl as unknown as Record<string, unknown>
  }
  if (view === 'meta-only') {
    return meta
  }
  if (view === 'channels-only') {
    return {
      channelCount: meta.channelCount,
      totalChannelCount: meta.totalChannelCount,
      channels: filtered.map(channelSummary),
    }
  }
  // summary (default)
  return { ...meta, channels: filtered.map(channelSummary) }
}
