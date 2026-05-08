// Парсеры и форматтеры шаблонов wb-mqtt-serial. Вынесены сюда, чтобы
// покрыть unit-тестами без mock'а MQTT — handler'ы в tools.ts вытаскивают
// сырой RPC-ответ и читают файл шаблона, потом гонят через эти функции.

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
