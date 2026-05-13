import { Bonjour } from 'bonjour-service'
import { promises as dns } from 'node:dns'
import { exec } from 'node:child_process'
import type { DbHandle } from './db.ts'

export type Controller = {
  sn: string
  host: string
  addresses: string[]
  port?: number
  lastSeen: number
  source: 'mdns' | 'manual'
  reachable?: boolean
  fw?: string
  hostname?: string
}

const SN_FROM_HOST = /^wirenboard-([a-z0-9]+)(?:\.local)?$/i

export class Discovery {
  private bonjour = new Bonjour()
  private controllers = new Map<string, Controller>()
  private browsers: ReturnType<Bonjour['find']>[] = []
  private timer: ReturnType<typeof setInterval> | null = null
  private listeners = new Set<(c: Controller[]) => void>()
  private lastSig = ''

  constructor(private db: DbHandle) {}

  private intervalMs = 15000

  start(intervalMs: number) {
    this.intervalMs = Math.max(1000, intervalMs)
    this.loadManualFromDb()
    this.startBrowsers()
    this.timer = setInterval(() => this.refresh(), this.intervalMs)
    void this.refresh()
  }

  /** Reset the periodic scan interval (called when settings.discoveryInterval changes). */
  setInterval(intervalMs: number): void {
    const next = Math.max(1000, intervalMs)
    if (next === this.intervalMs && this.timer) return
    this.intervalMs = next
    if (this.timer) clearInterval(this.timer)
    this.timer = setInterval(() => this.refresh(), this.intervalMs)
    void this.refresh()
  }

  /** Resolve a bare IP or hostname into a Controller on-the-fly (not persisted). */
  getOrCreate(snOrHost: string): Controller | undefined {
    const upper = snOrHost.toUpperCase()
    // 1. Try existing registry by SN
    const existing = this.controllers.get(upper)
    if (existing) return existing
    // 2. Try matching by host field; strip an optional :port so callers passing
    //    "1.2.3.4:2222" still hit the controller stored with just the host.
    const { host: needle } = parseHostPort(snOrHost)
    for (const c of this.controllers.values()) {
      if (c.host === snOrHost || c.host === needle || c.addresses.includes(needle)) return c
    }
    return undefined
  }

  private loadManualFromDb() {
    const rows = this.db
      .query<{ sn: string; host: string; port: number | null; added_at: number }, []>(
        `SELECT sn, host, port, added_at FROM manual_controllers`,
      )
      .all()
    for (const r of rows) {
      const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(r.host)
      this.controllers.set(r.sn, {
        sn: r.sn,
        host: r.host,
        addresses: isIp ? [r.host] : [],
        port: r.port ?? undefined,
        lastSeen: r.added_at,
        source: 'manual',
      })
    }
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    for (const b of this.browsers) b.stop()
    this.browsers = []
    this.bonjour.destroy()
  }

  list(): Controller[] {
    return [...this.controllers.values()].sort((a, b) => a.sn.localeCompare(b.sn))
  }

  get(sn: string): Controller | undefined {
    return this.controllers.get(sn.toUpperCase())
  }

  addManual(input: string): Controller {
    const { host, port } = parseHostPort(input)
    const sn = parseSn(host) ?? host.toUpperCase()
    const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(host)
    const c: Controller = {
      sn,
      host,
      addresses: isIp ? [host] : [],
      port,
      lastSeen: Date.now(),
      source: 'manual',
    }
    this.controllers.set(sn, c)
    this.db
      .query(
        `INSERT INTO manual_controllers (sn, host, port, added_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(sn) DO UPDATE SET host = excluded.host, port = excluded.port`,
      )
      .run(sn, host, port ?? null, c.lastSeen)
    this.notify()
    return c
  }

  remove(sn: string) {
    const key = sn.toUpperCase()
    this.db.query(`DELETE FROM manual_controllers WHERE sn = ?`).run(key)
    if (this.controllers.delete(key)) this.notify()
  }

  onChange(fn: (c: Controller[]) => void) {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  refresh = async () => {
    await Promise.all([this.resolveKnown(), this.avahiBrowse()])
    // Periodic scans always emit so the UI can show "last scanned just now"
    // even when nothing changed; signature dedup is preserved for high-frequency
    // bonjour up/down chatter only.
    this.notify(true)
  }

  private async resolveKnown() {
    const probes = [...this.controllers.values()]
      .filter((c) => c.host.endsWith('.local'))
      .map(async (c) => {
        try {
          const addrs = await dns.lookup(c.host, { all: true, family: 0 })
          c.addresses = addrs.map((a) => a.address)
          c.reachable = true
          c.lastSeen = Date.now()
        } catch {
          c.reachable = false
        }
      })
    await Promise.all(probes)
  }

  /** On Linux: use avahi-browse to find controllers bonjour-service misses.
   *  We run without -t so avahi collects responses for a full 5 s window,
   *  catching controllers that announce late. The process is killed via timeout. */
  private avahiBrowse(): Promise<void> {
    if (process.platform !== 'linux') return Promise.resolve()
    return new Promise((resolve) => {
      // timeout 5: kills avahi-browse after 5 s so we get a complete picture
      exec('timeout 5 avahi-browse -a -r -p 2>/dev/null; true', { timeout: 8000 }, (_err, stdout) => {
        for (const line of stdout.split('\n')) {
          if (!line.startsWith('=')) continue
          const p = line.split(';')
          // =;iface;proto;name;type;domain;hostname;address;port;txt
          const host = p[6]?.trim()
          const addr = p[7]?.trim()
          if (!host) continue
          const sn = parseSn(host)
          if (!sn) continue
          this.onService({ host, addresses: addr ? [addr] : [] })
        }
        resolve()
      })
    })
  }

  private startBrowsers() {
    // Wirenboard controllers expose at least _http._tcp and _ssh._tcp via Avahi.
    // Filter by hostname matching `wirenboard-*` to avoid catching unrelated devices.
    const types = ['http', 'ssh', 'workstation']
    for (const type of types) {
      const browser = this.bonjour.find({ type })
      browser.on('up', (svc) => this.onService(svc))
      browser.on('down', () => {})
      this.browsers.push(browser)
    }
  }

  private onService(svc: { host?: string; addresses?: string[]; port?: number }) {
    if (!svc.host) return
    const sn = parseSn(svc.host)
    if (!sn) return
    const key = sn.toUpperCase()
    const existing = this.controllers.get(key)
    const merged: Controller = {
      sn: key,
      host: svc.host,
      addresses: svc.addresses ?? existing?.addresses ?? [],
      port: svc.port ?? existing?.port,
      lastSeen: Date.now(),
      source: existing?.source === 'manual' ? 'manual' : 'mdns',
      reachable: true,
      fw: existing?.fw,
      hostname: existing?.hostname,
    }
    this.controllers.set(key, merged)
    this.notify()
  }

  private notify(force: boolean = false) {
    const snapshot = this.list()
    const sig = snapshot
      .map((c) => `${c.sn}|${c.host}|${c.reachable ?? '?'}|${c.addresses.join(',')}`)
      .join(';')
    if (!force && sig === this.lastSig) return
    this.lastSig = sig
    for (const fn of this.listeners) fn(snapshot)
  }
}

export function parseSn(host: string): string | null {
  const trimmed = host.trim().replace(/\.$/, '')
  const m = trimmed.match(SN_FROM_HOST)
  return m && m[1] ? m[1].toUpperCase() : null
}

export function defaultHost(sn: string): string {
  return `wirenboard-${sn.toLowerCase()}.local`
}

/** Split a free-form "host[:port]" string into parts. Port must be a positive
 *  integer ≤ 65535; otherwise it's silently dropped so a stray colon doesn't
 *  break the host. IPv6 literals aren't supported — too edge-case for the UI. */
export function parseHostPort(input: string): { host: string; port?: number } {
  const trimmed = input.trim()
  const colon = trimmed.lastIndexOf(':')
  if (colon < 0) return { host: trimmed }
  // Reject if it looks like IPv6 (multiple colons) — keep host as-is.
  if (trimmed.indexOf(':') !== colon) return { host: trimmed }
  const host = trimmed.slice(0, colon)
  const portStr = trimmed.slice(colon + 1)
  const port = Number(portStr)
  if (!host || !Number.isInteger(port) || port <= 0 || port > 65535) return { host: trimmed }
  return { host, port }
}
