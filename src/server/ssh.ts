import { Client, type ConnectConfig } from 'ssh2'
import { existsSync, readFileSync } from 'node:fs'
import type { Controller } from './discovery.ts'

export type SshAuth = {
  user: string
  password: string
  keyPath: string
}

export type ExecResult = {
  stdout: string
  stderr: string
  code: number | null
  signal: string | null
  truncated: boolean
}

const CONNECT_TIMEOUT = 4000
const DEFAULT_EXEC_TIMEOUT = 10_000
const MAX_EXEC_TIMEOUT = 120_000
const MAX_BUFFER = 1_000_000  // 1 MB на stdout+stderr на один exec

type Conn = {
  client: Client
  ready: Promise<void>
  lastUsed: number
}

export class SshPool {
  private conns = new Map<string, Conn>()
  private auth: SshAuth

  constructor(auth: SshAuth) {
    this.auth = auth
  }

  setAuth(auth: SshAuth) {
    this.auth = auth
    // Закрыть старые соединения — они авторизовались под предыдущими кредами.
    void this.closeAll()
  }

  async closeAll() {
    for (const c of this.conns.values()) c.client.end()
    this.conns.clear()
  }

  async exec(controller: Controller, command: string, timeoutMs = DEFAULT_EXEC_TIMEOUT): Promise<ExecResult> {
    const limit = Math.min(timeoutMs, MAX_EXEC_TIMEOUT)
    const conn = await this.connect(controller)
    return await new Promise<ExecResult>((resolve, reject) => {
      conn.client.exec(command, (err, ch) => {
        if (err) return reject(err)
        let stdout = ''
        let stderr = ''
        let truncated = false
        let code: number | null = null
        let signal: string | null = null

        const timeout = setTimeout(() => {
          truncated = true
          ch.signal('KILL')
          ch.close()
        }, limit)

        ch.on('data', (chunk: Buffer) => {
          if (stdout.length + chunk.length > MAX_BUFFER) {
            truncated = true
            stdout += chunk.subarray(0, MAX_BUFFER - stdout.length).toString('utf8')
          } else {
            stdout += chunk.toString('utf8')
          }
        })
        ch.stderr.on('data', (chunk: Buffer) => {
          if (stderr.length + chunk.length > MAX_BUFFER) {
            truncated = true
            stderr += chunk.subarray(0, MAX_BUFFER - stderr.length).toString('utf8')
          } else {
            stderr += chunk.toString('utf8')
          }
        })
        ch.on('exit', (c: number | null, sig: string | null) => {
          code = c
          signal = sig
        })
        ch.on('close', () => {
          clearTimeout(timeout)
          conn.lastUsed = Date.now()
          resolve({ stdout, stderr, code, signal, truncated })
        })
        ch.on('error', (e: Error) => {
          clearTimeout(timeout)
          reject(e)
        })
      })
    })
  }

  async readFile(controller: Controller, path: string, maxBytes = 64_000): Promise<{ content: string; truncated: boolean }> {
    // Простой и портативный путь: head -c через exec, без SFTP-сессии.
    const escaped = shellEscape(path)
    const r = await this.exec(controller, `head -c ${maxBytes + 1} ${escaped}`, 15_000)
    if (r.code !== 0) {
      throw new Error(r.stderr.trim() || `read failed (exit ${r.code})`)
    }
    if (r.stdout.length > maxBytes) {
      return { content: r.stdout.slice(0, maxBytes), truncated: true }
    }
    return { content: r.stdout, truncated: false }
  }

  async readLogs(controller: Controller, unit?: string, lines = 200): Promise<string> {
    const safeLines = Math.max(1, Math.min(2000, Math.floor(lines)))
    const cmd = unit
      ? `journalctl --no-pager -n ${safeLines} -u ${shellEscape(unit)}`
      : `journalctl --no-pager -n ${safeLines}`
    const r = await this.exec(controller, cmd, 20_000)
    if (r.code !== 0 && !r.stdout) {
      throw new Error(r.stderr.trim() || `journalctl exited ${r.code}`)
    }
    return r.stdout
  }

  private async connect(controller: Controller): Promise<Conn> {
    const key = controller.sn
    const existing = this.conns.get(key)
    if (existing) {
      try {
        await existing.ready
        existing.lastUsed = Date.now()
        return existing
      } catch {
        this.conns.delete(key)
      }
    }
    // Каскад: ключ (если задан) → пароль. Если ключ есть, но не подошёл —
    // ssh2 кидает «All configured authentication methods failed». Пробуем пароль.
    const attempts = this.authAttempts()
    let lastErr: unknown = new Error('no auth methods')
    for (const cfg of attempts) {
      try {
        const conn = await this.tryConnect(controller, cfg)
        this.conns.set(key, conn)
        conn.client.on('close', () => this.conns.delete(key))
        conn.client.on('error', () => this.conns.delete(key))
        return conn
      } catch (e) {
        lastErr = e
        if (!isAuthError(e)) throw e
      }
    }
    throw lastErr
  }

  private authAttempts(): AuthVariant[] {
    const out: AuthVariant[] = []
    if (this.auth.keyPath && existsSync(this.auth.keyPath)) {
      try {
        const privateKey = readFileSync(this.auth.keyPath)
        out.push({ kind: 'key', privateKey })
      } catch {}
    }
    if (this.auth.password) {
      out.push({ kind: 'password', password: this.auth.password })
    }
    return out
  }

  private tryConnect(controller: Controller, variant: AuthVariant): Promise<Conn> {
    const cfg = this.baseConfig(controller)
    if (variant.kind === 'key') {
      cfg.privateKey = variant.privateKey
    } else {
      cfg.password = variant.password
      cfg.tryKeyboard = true
    }
    const client = new Client()
    const ready = new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('ssh connect timeout')), CONNECT_TIMEOUT + 1000)
      client.once('ready', () => {
        clearTimeout(t)
        resolve()
      })
      client.once('error', (e) => {
        clearTimeout(t)
        reject(e)
      })
      // keyboard-interactive с тем же паролем, если сервер так просит.
      if (variant.kind === 'password') {
        client.on('keyboard-interactive', (_n, _i, _l, _p, finish) => finish([variant.password]))
      }
      client.connect(cfg)
    })
    return ready.then(() => ({ client, ready: Promise.resolve(), lastUsed: Date.now() }))
  }

  private baseConfig(controller: Controller): ConnectConfig {
    const host = controller.addresses[0] ?? controller.host
    const port = controller.port ?? 22
    return {
      host,
      port,
      username: this.auth.user || 'root',
      readyTimeout: CONNECT_TIMEOUT,
      // На Wirenboard стоит OpenSSH с обычными алгоритмами; явно расширим набор
      // на случай старых дистрибутивов.
      algorithms: {
        kex: [
          'curve25519-sha256',
          'curve25519-sha256@libssh.org',
          'diffie-hellman-group14-sha256',
          'diffie-hellman-group14-sha1',
        ],
        serverHostKey: ['ssh-ed25519', 'rsa-sha2-512', 'rsa-sha2-256', 'ssh-rsa'],
      },
    }
  }
}

type AuthVariant =
  | { kind: 'key'; privateKey: Buffer }
  | { kind: 'password'; password: string }

function isAuthError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e)
  return /authentication|auth methods|No supported authentication/i.test(msg)
}

function shellEscape(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}
