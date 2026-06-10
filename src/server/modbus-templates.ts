// Parsers and formatters for wb-mqtt-serial templates. Split out so they can be
// unit-tested without mocking MQTT — handlers in tools.ts pull the raw RPC
// response and read the template file, then run them through these functions.

/** Enrich a `wb-mqtt-serial/device/<method>` RPC error with a diagnostic hint.
 *  Specifically: on timeout, note that an outdated driver (< 2.180) may not
 *  serve this endpoint — observed on wb-mqtt-serial 2.146.0 (current in stable
 *  wb7 repo is 2.224+). For non-outdated versions the error keeps its original
 *  meaning (network/bad params/etc), just with an added "timeout" cause hint.
 */
export function enrichSerialRpcError(e: unknown, method: string): string {
  const raw = e instanceof Error ? e.message : String(e)
  if (/таймаут|timeout/i.test(raw)) {
    return (
      `${raw}. ` +
      `On outdated wb-mqtt-serial versions (<2.180) the device/${method} endpoint may be non-functional — ` +
      `check \`dpkg -l wb-mqtt-serial\`. If the version is below 2.180, update: \`apt update && apt install wb-mqtt-serial\` ` +
      `(confirm the operation with the user — it restarts the driver).`
    )
  }
  return raw
}

/** Build params for the `wb-mqtt-serial/device/LoadConfig` RPC.
 *
 *  Two modes:
 *    1. By `device_id` (MQTT device name, e.g. "wb-mr6c_138") — wb-mqtt-serial
 *       resolves the rest from its own config.
 *    2. By explicit `{path, slave_id, device_type, baud_rate, parity, data_bits, stop_bits}`
 *       — for a device not yet in the config (after a bus scan).
 *
 *  If `device_id` is set, the other fields are ignored (it wins). With no
 *  `device_id` and no `path+slave_id`, returns null (caller should report
 *  "need either device_id or path+slave_id").
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
  // Recent wb-mqtt-serial (2.224+) requires data_bits/parity/stop_bits — without
  // them the RPC returns "Missing required property" (JSON-schema validation).
  // Older versions treated them as optional. Fill in safe modbus defaults
  // (8/N/2) when the caller didn't pass them — correct for 99% of RS-485
  // devices. baud_rate too (9600 — the standard wb-mqtt-serial config default).
  const out: Record<string, unknown> = {
    path: args.path,
    slave_id: args.slave_id,
    baud_rate: typeof args.baud_rate === 'number' ? args.baud_rate : 9600,
    // `||` (not `??`) — an empty parity string is useless, treat as unset.
    parity: args.parity || 'N',
    data_bits: typeof args.data_bits === 'number' ? args.data_bits : 8,
    stop_bits: typeof args.stop_bits === 'number' ? args.stop_bits : 2,
  }
  if (args.device_type) out['device_type'] = args.device_type
  return out
}

/** One template in the flat list (after flattening Load.types groups). */
export type TemplateInfo = {
  type: string // device_type from the template (e.g. "WB-MR6C")
  mqttId: string // normalized id (e.g. "wb-mr6c") — from the Load.types mqtt-id field
  name: string // human-readable name
  deprecated: boolean
  group: string // group name (e.g. "Реле и диммеры")
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

/** Flatten `wb-mqtt-serial/config/Load.types` into a flat TemplateInfo array.
 *  Skips empty groups. If a template has no mqtt-id, falls back to lowercased
 *  device_type (some old templates lack a separate mqtt-id field).
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

/** Substring filter over type/mqttId/name (case-insensitive). Empty string →
 *  everything. */
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

/** Per-group aggregate — `{group: {count, deprecated_count}}`. Used by
 *  `modbus_templates_list` without a filter — to avoid returning 250+ records
 *  at once and blowing the token limit. With a filter the handler returns a
 *  flat list of matches. */
export function summarizeByGroup(list: TemplateInfo[]): Record<string, { count: number; deprecated: number }> {
  const out: Record<string, { count: number; deprecated: number }> = {}
  for (const t of list) {
    const g = (out[t.group] = out[t.group] ?? { count: 0, deprecated: 0 })
    g.count++
    if (t.deprecated) g.deprecated++
  }
  return out
}

// ── Render one template (contents of /usr/share/wb-mqtt-serial/templates/…json) ──

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

/** Extract compact channel info for view='summary'. */
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

/** Apply enabledOnly/channelFilter (case-insensitive substring over name) to
 *  the channels list. */
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

/** Render a template into one of the views. Every view filters channels via
 *  `filterChannels` (when opts are given).
 *
 *    - summary (default): {device_type, title, deviceName, deviceId, channelCount, channels: [{name, reg_type, address, format, type, units}]}
 *    - full: the whole template as-is
 *    - channels-only: just {channelCount, channels: [...]} (no device meta)
 *    - meta-only: just {device_type, title, deviceName, deviceId, parametersCount, channelCount} — no channels or parameters
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
    // Full template, but with filtered channels (when a filter is set)
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
