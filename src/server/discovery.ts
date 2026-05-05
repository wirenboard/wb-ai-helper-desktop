import { Bonjour } from 'bonjour-service'
import { promises as dns } from 'node:dns'
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

  start(intervalMs: number) {
    this.loadManualFromDb()
    this.startBrowsers()
    this.timer = setInterval(() => this.refresh(), intervalMs)
    void this.refresh()
  }

  private loadManualFromDb() {
    const rows = this.db
      .query<{ sn: string; host: string; added_at: number }, []>(
        `SELECT sn, host, added_at FROM manual_controllers`,
      )
      .all()
    for (const r of rows) {
      this.controllers.set(r.sn, {
        sn: r.sn,
        host: r.host,
        addresses: [],
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

  addManual(host: string): Controller {
    const sn = parseSn(host) ?? host.toUpperCase()
    const c: Controller = {
      sn,
      host,
      addresses: [],
      lastSeen: Date.now(),
      source: 'manual',
    }
    this.controllers.set(sn, c)
    this.db
      .query(
        `INSERT INTO manual_controllers (sn, host, added_at) VALUES (?, ?, ?)
         ON CONFLICT(sn) DO UPDATE SET host = excluded.host`,
      )
      .run(sn, host, c.lastSeen)
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
    // Resolve known mDNS hosts to fresh addresses + mark reachable.
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
    this.notify()
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

  private notify() {
    const snapshot = this.list()
    // Скан крутится каждые 15с; если ничего не поменялось — не дёргаем SSE-клиентов
    // и не заставляем фронт перерендеривать список зря.
    const sig = snapshot
      .map((c) => `${c.sn}|${c.host}|${c.reachable ?? '?'}|${c.addresses.join(',')}`)
      .join(';')
    if (sig === this.lastSig) return
    this.lastSig = sig
    for (const fn of this.listeners) fn(snapshot)
  }
}

function parseSn(host: string): string | null {
  const trimmed = host.trim().replace(/\.$/, '')
  const m = trimmed.match(SN_FROM_HOST)
  return m && m[1] ? m[1].toUpperCase() : null
}

export function defaultHost(sn: string): string {
  return `wirenboard-${sn.toLowerCase()}.local`
}
