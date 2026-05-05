import mqtt, { MqttClient } from 'mqtt'
import type { Controller } from './discovery.ts'

type Conn = {
  client: MqttClient
  topics: Map<string, string>
  ready: Promise<void>
}

const CONNECT_TIMEOUT = 4000
const READ_TIMEOUT = 1500

export class MqttPool {
  private conns = new Map<string, Conn>()
  constructor(
    private readonly auth: { user?: string; password?: string } = {},
  ) {}

  async close() {
    for (const c of this.conns.values()) c.client.end(true)
    this.conns.clear()
  }

  /** List devices on a controller by inspecting `/devices/+/meta/name` retains. */
  async listDevices(c: Controller): Promise<{ id: string; name: string }[]> {
    const topics = await this.collect(c, '/devices/+/meta/name', 800)
    return [...topics.entries()]
      .map(([t, v]) => {
        const m = t.match(/^\/devices\/([^/]+)\/meta\/name$/)
        return m && m[1] ? { id: m[1], name: v } : null
      })
      .filter((x): x is { id: string; name: string } => !!x)
      .sort((a, b) => a.id.localeCompare(b.id))
  }

  /** List controls of a device. */
  async listControls(c: Controller, deviceId: string): Promise<{ id: string; value: string }[]> {
    const topics = await this.collect(c, `/devices/${deviceId}/controls/+`, 800)
    return [...topics.entries()]
      .filter(([t]) => !t.includes('/meta'))
      .map(([t, v]) => {
        const m = t.match(/^\/devices\/[^/]+\/controls\/([^/]+)$/)
        return m && m[1] ? { id: m[1], value: v } : null
      })
      .filter((x): x is { id: string; value: string } => !!x)
  }

  async readTopic(c: Controller, topic: string): Promise<string | null> {
    const conn = await this.connect(c)
    return await new Promise<string | null>((resolve) => {
      let done = false
      const onMsg = (t: string, payload: Buffer) => {
        if (t !== topic) return
        if (done) return
        done = true
        conn.client.removeListener('message', onMsg)
        conn.client.unsubscribe(topic, () => {})
        resolve(payload.toString('utf8'))
      }
      conn.client.on('message', onMsg)
      conn.client.subscribe(topic, { qos: 0 }, (err) => {
        if (err && !done) {
          done = true
          conn.client.removeListener('message', onMsg)
          resolve(null)
        }
      })
      setTimeout(() => {
        if (done) return
        done = true
        conn.client.removeListener('message', onMsg)
        conn.client.unsubscribe(topic, () => {})
        resolve(null)
      }, READ_TIMEOUT)
    })
  }

  async writeTopic(c: Controller, topic: string, payload: string): Promise<void> {
    const conn = await this.connect(c)
    await new Promise<void>((resolve, reject) => {
      conn.client.publish(topic, payload, { qos: 1, retain: false }, (err) =>
        err ? reject(err) : resolve(),
      )
    })
  }

  /** Subscribe to a wildcard pattern for `windowMs` and return all retains seen. */
  private async collect(
    c: Controller,
    pattern: string,
    windowMs: number,
  ): Promise<Map<string, string>> {
    const conn = await this.connect(c)
    const out = new Map<string, string>()
    return await new Promise<Map<string, string>>((resolve) => {
      const onMsg = (t: string, payload: Buffer) => out.set(t, payload.toString('utf8'))
      conn.client.on('message', onMsg)
      conn.client.subscribe(pattern, { qos: 0 }, () => {})
      setTimeout(() => {
        conn.client.removeListener('message', onMsg)
        conn.client.unsubscribe(pattern, () => {})
        resolve(out)
      }, windowMs)
    })
  }

  private async connect(c: Controller): Promise<Conn> {
    const key = c.sn
    const existing = this.conns.get(key)
    if (existing) {
      await existing.ready
      return existing
    }
    const url = `mqtt://${c.host}:1883`
    const client = mqtt.connect(url, {
      clientId: `wb-ai-helper-${Math.random().toString(16).slice(2)}`,
      reconnectPeriod: 0,
      connectTimeout: CONNECT_TIMEOUT,
      username: this.auth.user,
      password: this.auth.password,
    })
    const conn: Conn = {
      client,
      topics: new Map(),
      ready: new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('mqtt connect timeout')), CONNECT_TIMEOUT + 500)
        client.once('connect', () => {
          clearTimeout(t)
          resolve()
        })
        client.once('error', (e) => {
          clearTimeout(t)
          reject(e)
        })
      }),
    }
    this.conns.set(key, conn)
    try {
      await conn.ready
    } catch (e) {
      this.conns.delete(key)
      client.end(true)
      throw e
    }
    return conn
  }
}
