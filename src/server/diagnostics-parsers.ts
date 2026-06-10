// Pure parsers for diagnostic tools. Extracted here to unit-test without
// mocking ssh — handlers in tools.ts just pull raw stdout from ssh.exec and
// feed it through these functions.

/** Split output into sections marked by `===LABEL===` markers on their own
 *  lines. Returns the trimmed content of the requested section (no trailing
 *  newline). Empty string if the marker isn't found.
 *
 *  `===` marker pairs are used by `network_status`, `cloud_status`,
 *  `systemd_unit`-status handlers — one shell call emits N sections back to
 *  back, then the TS side slices by label. */
export function readMarkedSection(stdout: string, label: string): string {
  const marker = `===${label}===`
  const start = stdout.indexOf(marker)
  if (start < 0) return ''
  const after = start + marker.length
  const next = stdout.indexOf('\n===', after)
  return stdout.slice(after, next < 0 ? undefined : next).trim()
}

/** Ping from `ping -c1 -W2 <host> 2>&1 | tail -2` — output has a line like
 *  `1 packets transmitted, 0 received, 100% packet loss, time 0ms`. Returns
 *  loss percent (0..100), or null if the line is absent. */
export function parsePingLossPct(raw: string): number | null {
  const m = raw.match(/(\d+)% packet loss/)
  return m ? Number(m[1]) : null
}

/** Normalize one entry from `ip -j addr show` into a compact object
 *  {name, state, mtu, ipv4[]}. Takes `any` because the `ip -j` schema isn't
 *  fixed — we guard against fields that may be missing. */
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

/** Default route from `ip -j route show default` — array of {gateway, dev}
 *  entries. Takes the first (in practice controllers with multiple default
 *  routes are rare; nm/wb-connection-manager usually keeps one). */
export function pickDefaultRoute(routes: unknown): { gateway: string; dev: string } | null {
  if (!Array.isArray(routes) || routes.length === 0) return null
  const r = (routes[0] ?? {}) as Record<string, unknown>
  if (typeof r['gateway'] !== 'string' || typeof r['dev'] !== 'string') return null
  return { gateway: r['gateway'] as string, dev: r['dev'] as string }
}

/** Parse `nmcli -t -f F1,F2,... <subcommand>` output — columns split by `:`,
 *  rows by `\n`. `fields` are the column names in the same order as passed to
 *  `-f`. Returns an array of objects keyed by those names. Empty lines are
 *  ignored. */
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

// Parse `mosquitto_sub -F '%t\t%p'` output filtered to
// `/devices/system__wb-cloud-agent__<id>/controls/<name>` into a
// `{provider: {control: payload}}` structure. Ignores `meta` topics (control
// values are stored separately from their meta).
//
// Used by the `cloud_status` handler — wb-cloud-agent publishes a set of
// controls per bound provider (system__wb-cloud-agent__<provider_id>):
// status, activation_link, cloud_base_url.
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
