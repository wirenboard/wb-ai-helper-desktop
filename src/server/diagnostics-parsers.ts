// Чистые парсеры для diagnostic-tool'ов. Вынесены сюда, чтобы покрыть
// unit-тестами без mock'а ssh — handler'ы в tools.ts вытаскивают только
// сырой stdout из ssh.exec и прогоняют его через эти функции.

/** Разбить вывод на секции, помеченные `===LABEL===` маркерами на отдельных
 *  строках. Возвращает trim'нутое содержимое запрошенной секции (без
 *  завершающего перевода строки). Если маркер не найден — пустая строка.
 *
 *  Парные `===` маркеры используются handler'ами `network_status`,
 *  `cloud_status`, `systemd_unit`-status — один shell-вызов выводит N
 *  секций друг за другом, потом TS-сторона нарезает по ярлыкам. */
export function readMarkedSection(stdout: string, label: string): string {
  const marker = `===${label}===`
  const start = stdout.indexOf(marker)
  if (start < 0) return ''
  const after = start + marker.length
  const next = stdout.indexOf('\n===', after)
  return stdout.slice(after, next < 0 ? undefined : next).trim()
}

/** Пинг от `ping -c1 -W2 <host> 2>&1 | tail -2` — в выводе есть строка вида
 *  `1 packets transmitted, 0 received, 100% packet loss, time 0ms`. Возвращает
 *  процент потерь (0..100), либо null если строки нет. */
export function parsePingLossPct(raw: string): number | null {
  const m = raw.match(/(\d+)% packet loss/)
  return m ? Number(m[1]) : null
}

/** Нормализовать одну запись из `ip -j addr show` в компактный объект
 *  {name, state, mtu, ipv4[]}. Принимает `any` потому что схема `ip -j`
 *  не зафиксирована — выкручиваемся out-of-the-box, защищаемся от полей
 *  которые могут отсутствовать. */
export function normalizeInterface(raw: unknown): {
  name: string
  state: string
  mtu: number | null
  ipv4: string[]
} {
  const i = (raw ?? {}) as Record<string, unknown>
  const addrInfo = Array.isArray(i['addr_info']) ? (i['addr_info'] as unknown[]) : []
  return {
    name: typeof i['ifname'] === 'string' ? (i['ifname'] as string) : '',
    state: typeof i['operstate'] === 'string' ? (i['operstate'] as string) : '',
    mtu: typeof i['mtu'] === 'number' ? (i['mtu'] as number) : null,
    ipv4: addrInfo
      .map((a) => {
        const o = (a ?? {}) as Record<string, unknown>
        return typeof o['local'] === 'string' && typeof o['prefixlen'] === 'number'
          ? `${o['local']}/${o['prefixlen']}`
          : null
      })
      .filter((x): x is string => x !== null),
  }
}

/** Дефолт-маршрут от `ip -j route show default` — массив записей с полями
 *  {gateway, dev}. Берём первый (на практике контроллеры с несколькими
 *  default-маршрутами редкость; nm/wb-connection-manager обычно держит один). */
export function pickDefaultRoute(routes: unknown): { gateway: string; dev: string } | null {
  if (!Array.isArray(routes) || routes.length === 0) return null
  const r = (routes[0] ?? {}) as Record<string, unknown>
  if (typeof r['gateway'] !== 'string' || typeof r['dev'] !== 'string') return null
  return { gateway: r['gateway'] as string, dev: r['dev'] as string }
}

/** Распарсить вывод `nmcli -t -f F1,F2,... <subcommand>` — колонки разделены
 *  `:`, строки `\n`. fields — имена колонок в том же порядке, в каком они
 *  переданы в `-f`. Возвращает массив объектов с этими именами. Пустые
 *  строки игнорируются. */
export function parseNmcliColons<F extends string>(
  out: string,
  fields: readonly F[],
): Array<Record<F, string>> {
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(':')
      const obj = {} as Record<F, string>
      fields.forEach((f, i) => {
        obj[f] = parts[i] ?? ''
      })
      return obj
    })
}

// Распарсить вывод `mosquitto_sub -F '%t\t%p'` отфильтрованный по
// `/devices/system__wb-cloud-agent__<id>/controls/<name>` в структуру
// `{provider: {control: payload}}`. Игнорирует `meta` топики (значения
// контролов хранятся отдельно от их meta).
//
// Используется handler'ом `cloud_status` — wb-cloud-agent публикует под
// каждый bound provider (system__wb-cloud-agent__<provider_id>) набор
// контролов: status, activation_link, cloud_base_url.
export function parseCloudMqttControls(
  raw: string,
): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {}
  for (const line of raw.split('\n')) {
    if (!line) continue
    const tab = line.indexOf('\t')
    if (tab < 0) continue
    const topic = line.slice(0, tab)
    const payload = line.slice(tab + 1)
    if (topic.endsWith('/meta') || topic.includes('/meta/')) continue
    const m = topic.match(
      /^\/devices\/(system__wb-cloud-agent__[^/]+)\/controls\/([^/]+)$/,
    )
    if (!m || !m[1] || !m[2]) continue
    const provider = m[1]
    const control = m[2]
    out[provider] = out[provider] ?? {}
    out[provider]![control] = payload
  }
  return out
}
