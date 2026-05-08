// Парсеры и билдер inventory-снимка для tool'а `mqtt_inventory`.
// Вынесены в отдельный модуль, чтобы покрыть unit-тестами без mock-MQTT —
// handler в tools.ts вытаскивает топики через MqttPool.listTopics и
// прогоняет их через `buildInventory`.

/** WB MQTT Conventions error codes (https://github.com/wirenboard/conventions):
 *    `r` — read error / device reports an error;
 *    `w` — write error;
 *    `p` — period miss (драйвер не успел опросить вовремя).
 *  Комбинации возможны: "rw", "rp", "rwp". Пустая строка / null = нет ошибок.
 *
 *  Важный нюанс: при `read=true` значение в value-топике — это
 *  last-known-good (последнее успешно прочитанное), а не текущий live-readout.
 *  Без этого знания модель часто делает неверный вывод вида «датчик в офлайне,
 *  но MQTT показывает 23°C». */
export type ErrorFlags = {
  raw: string
  read: boolean
  write: boolean
  periodMiss: boolean
  unknown?: string
}

export function parseErrorFlags(raw: string | undefined | null): ErrorFlags | undefined {
  if (raw == null || raw === '') return undefined
  const flags: ErrorFlags = { raw, read: false, write: false, periodMiss: false }
  let unknown = ''
  for (const ch of raw) {
    if (ch === 'r') flags.read = true
    else if (ch === 'w') flags.write = true
    else if (ch === 'p') flags.periodMiss = true
    else unknown += ch
  }
  if (unknown) flags.unknown = unknown
  return flags
}

export type Control = {
  name: string
  /** Когда `error.read=true` — это last-known-good (per WB Conventions). */
  value?: string
  type?: string
  units?: string
  readonly?: boolean
  order?: number
  min?: number
  max?: number
  precision?: number
  error?: ErrorFlags
  title?: unknown
  /** Полный raw meta-объект, попадает только при includeMeta=true. */
  meta?: Record<string, unknown>
}

export type Device = {
  id: string
  name?: string
  driver?: string
  error?: ErrorFlags
  controlCount: number
  controls: Control[]
}

export type Inventory = {
  count: number
  errorCount: number
  errors: Array<{ device: string; control?: string; flags: ErrorFlags }>
  devices: Device[]
}

function parseMetaJson(s: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(s)
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** Собрать inventory-снимок из плоского списка retained-топиков
 *  (`/devices/#` после `MqttPool.listTopics`). Чистая функция, тестируется
 *  без сети.
 *
 *  - filter: подстрока для фильтрации device_id (case-insensitive)
 *  - includeEmpty: оставлять устройства без контролов (только с meta)
 *  - includeMeta: класть весь raw meta-объект в каждый control'е
 */
export function buildInventory(
  topics: Iterable<readonly [string, string]>,
  opts: { filter?: string; includeEmpty?: boolean; includeMeta?: boolean } = {},
): Inventory {
  const devices = new Map<string, Device>()
  const ensureDev = (id: string): Device => {
    let d = devices.get(id)
    if (!d) {
      d = { id, controlCount: 0, controls: [] }
      devices.set(id, d)
    }
    return d
  }
  const ensureCtrl = (dev: Device, name: string): Control => {
    let c = dev.controls.find((c) => c.name === name)
    if (!c) {
      c = { name }
      dev.controls.push(c)
      dev.controlCount = dev.controls.length
    }
    return c
  }
  const filt = opts.filter?.toLowerCase()
  for (const [topic, payload] of topics) {
    const dev = topic.match(/^\/devices\/([^/]+)\/(.+)$/)
    if (!dev) continue
    const id = dev[1]!
    if (filt && !id.toLowerCase().includes(filt)) continue
    const rest = dev[2]!
    const d = ensureDev(id)
    const metaMatch = rest.match(/^meta(?:\/(.+))?$/)
    if (metaMatch) {
      const key = metaMatch[1]
      if (!key) {
        const obj = parseMetaJson(payload)
        if (obj) {
          if (typeof obj['name'] === 'string') d.name = obj['name'] as string
          if (typeof obj['driver'] === 'string') d.driver = obj['driver'] as string
          if (typeof obj['error'] === 'string') d.error = parseErrorFlags(obj['error'] as string)
        }
      } else if (key === 'name') d.name = payload
      else if (key === 'driver') d.driver = payload
      else if (key === 'error') d.error = parseErrorFlags(payload)
      continue
    }
    const ctrlMatch = rest.match(/^controls\/(.+)$/)
    if (!ctrlMatch) continue
    const ctrlPart = ctrlMatch[1]!
    // Имя контрола может содержать `/` только в виде `/meta` или `/meta/<key>`;
    // во всех остальных случаях это часть имени (имена с пробелами уже
    // обрабатываются на уровне MQTT-парсинга).
    const subMatch = ctrlPart.match(/^(.+?)\/meta(?:\/(.+))?$/)
    if (subMatch) {
      const ctrlName = subMatch[1]!
      const metaKey = subMatch[2]
      const c = ensureCtrl(d, ctrlName)
      if (!metaKey) {
        const obj = parseMetaJson(payload)
        if (obj) {
          if (typeof obj['type'] === 'string') c.type = obj['type'] as string
          if (typeof obj['units'] === 'string') c.units = obj['units'] as string
          if (typeof obj['readonly'] === 'boolean') c.readonly = obj['readonly'] as boolean
          if (typeof obj['order'] === 'number') c.order = obj['order'] as number
          if (typeof obj['min'] === 'number') c.min = obj['min'] as number
          if (typeof obj['max'] === 'number') c.max = obj['max'] as number
          if (typeof obj['precision'] === 'number') c.precision = obj['precision'] as number
          if (typeof obj['error'] === 'string') c.error = parseErrorFlags(obj['error'] as string)
          if (obj['title'] !== undefined) c.title = obj['title']
          if (opts.includeMeta) c.meta = obj
        }
      } else {
        if (metaKey === 'type') c.type = payload
        else if (metaKey === 'units') c.units = payload
        else if (metaKey === 'readonly') c.readonly = payload === '1' || payload === 'true'
        else if (metaKey === 'order') c.order = Number(payload)
        else if (metaKey === 'min') c.min = Number(payload)
        else if (metaKey === 'max') c.max = Number(payload)
        else if (metaKey === 'precision') c.precision = Number(payload)
        else if (metaKey === 'error') c.error = parseErrorFlags(payload)
      }
    } else {
      // /devices/<id>/controls/<name> — value-топик
      const c = ensureCtrl(d, ctrlPart)
      c.value = payload
    }
  }
  let arr = [...devices.values()]
  if (!opts.includeEmpty) arr = arr.filter((d) => d.controls.length > 0)
  arr.sort((a, b) => a.id.localeCompare(b.id))
  for (const d of arr) {
    d.controls.sort(
      (a, b) => (a.order ?? 999) - (b.order ?? 999) || a.name.localeCompare(b.name),
    )
  }
  const errors: Array<{ device: string; control?: string; flags: ErrorFlags }> = []
  for (const d of arr) {
    if (d.error) errors.push({ device: d.id, flags: d.error })
    for (const c of d.controls) {
      if (c.error) errors.push({ device: d.id, control: c.name, flags: c.error })
    }
  }
  return { count: arr.length, errorCount: errors.length, errors, devices: arr }
}
