import { Client, type ConnectConfig } from 'ssh2'
import { existsSync, readFileSync } from 'node:fs'
import type { Controller } from './discovery.ts'

const AI_BASE = '/mnt/data/ai/wb-ai-helper'
const JOB_DIR = `${AI_BASE}/jobs`
const JOB_UNIT_PREFIX = 'wb-ai-job-'
const JOB_TTL_SEC = 24 * 3600

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

  async readLogs(controller: Controller, unit?: string, lines = 200, priority?: string): Promise<string> {
    const safeLines = Math.max(1, Math.min(2000, Math.floor(lines)))
    const pFlag = priority ? ` -p ${shellEscape(priority)}` : ''
    const uFlag = unit ? ` -u ${shellEscape(unit)}` : ''
    const cmd = `journalctl --no-pager -n ${safeLines}${pFlag}${uFlag}`
    const r = await this.exec(controller, cmd, 20_000)
    if (r.code !== 0 && !r.stdout) {
      throw new Error(r.stderr.trim() || `journalctl exited ${r.code}`)
    }
    return r.stdout
  }

  async writeFile(controller: Controller, path: string, content: string): Promise<void> {
    const conn = await this.connect(controller)
    const buf = Buffer.from(content, 'utf8')
    await new Promise<void>((resolve, reject) => {
      conn.client.sftp((err, sftp) => {
        if (err) return reject(err)
        const ws = sftp.createWriteStream(path)
        ws.on('error', (e: Error) => { sftp.end(); reject(e) })
        ws.on('close', () => { sftp.end(); resolve() })
        ws.end(buf)
      })
    })
  }

  async downloadFile(controller: Controller, path: string, maxBytes = 20 * 1024 * 1024): Promise<Buffer> {
    const conn = await this.connect(controller)
    return new Promise<Buffer>((resolve, reject) => {
      conn.client.sftp((err, sftp) => {
        if (err) return reject(err)
        sftp.stat(path, (statErr, stats) => {
          if (statErr) { sftp.end(); return reject(statErr) }
          if (stats.size > maxBytes) {
            sftp.end()
            return reject(new Error(`file too large: ${stats.size} bytes (limit ${maxBytes}) — compress first`))
          }
          const rs = sftp.createReadStream(path)
          const chunks: Buffer[] = []
          let total = 0
          rs.on('data', (d: Buffer) => {
            total += d.length
            if (total > maxBytes) { rs.destroy(new Error(`exceeds ${maxBytes} bytes`)); return }
            chunks.push(d)
          })
          rs.on('error', (e: Error) => { sftp.end(); reject(e) })
          rs.on('end', () => { sftp.end(); resolve(Buffer.concat(chunks)) })
        })
      })
    })
  }

  async writeFileBuffer(controller: Controller, path: string, buf: Buffer): Promise<void> {
    const conn = await this.connect(controller)
    await new Promise<void>((resolve, reject) => {
      conn.client.sftp((err, sftp) => {
        if (err) return reject(err)
        const ws = sftp.createWriteStream(path)
        ws.on('error', (e: Error) => { sftp.end(); reject(e) })
        ws.on('close', () => { sftp.end(); resolve() })
        ws.end(buf)
      })
    })
  }

  async mqttRpc(
    controller: Controller,
    driver: string,
    service: string,
    method: string,
    params: Record<string, unknown>,
    timeoutSec = 5
  ): Promise<unknown> {
    const cid = `ai-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const topic = `/rpc/v1/${driver}/${service}/${method}/${cid}`
    const payload = JSON.stringify({ id: 1, params })
    const r = await this.exec(
      controller,
      `mosquitto_sub -t '${topic}/reply' -C 1 -W ${timeoutSec} &` +
      ` sleep 0.2;` +
      ` mosquitto_pub -t '${topic}' -m '${payload.replace(/'/g, `'\\''`)}';` +
      ` wait`,
      (timeoutSec + 3) * 1000
    )
    const out = r.stdout.trim()
    if (!out) throw new Error(`RPC ${driver}/${service}/${method} — нет ответа (таймаут ${timeoutSec}с)`)
    const parsed = JSON.parse(out)
    if (parsed.error) throw new Error(`RPC ${driver}/${service}/${method} ошибка: ${JSON.stringify(parsed.error)}`)
    return parsed.result
  }

  async mqttListTopics(controller: Controller, prefix = '#', timeoutSec = 2): Promise<string[]> {
    let filter = prefix
    if (!/[#+]/.test(filter)) {
      filter = filter.endsWith('/') ? filter + '#' : filter + '/#'
    }
    const safeFilter = filter.replace(/'/g, '')
    const r = await this.exec(
      controller,
      `mosquitto_sub -t '${safeFilter}' -W ${timeoutSec} -v 2>/dev/null | sed 's/ [^ ]*$//' | sort -u`,
      (timeoutSec + 2) * 1000
    )
    return r.stdout.split('\n').map(l => l.trim()).filter(Boolean)
  }

  async mqttPublish(controller: Controller, topic: string, payload: string): Promise<void> {
    const safeTopic = topic.replace(/'/g, '')
    const safePayload = payload.replace(/'/g, `'\\''`)
    const r = await this.exec(controller, `mosquitto_pub -t '${safeTopic}' -m '${safePayload}'`)
    if (r.code !== 0) throw new Error(`mosquitto_pub failed: ${r.stderr.trim() || r.code}`)
  }

  async getInfo(controller: Controller): Promise<Record<string, string>> {
    const r = await this.exec(
      controller,
      'echo HOST; hostname; echo UNAME; uname -a; echo UPTIME; uptime; echo RELEASE; cat /etc/wb-release 2>/dev/null; echo FW; cat /etc/wb-fw-version 2>/dev/null'
    )
    const sections = r.stdout.split(/^(HOST|UNAME|UPTIME|RELEASE|FW)$/m)
    const get = (name: string) => {
      const i = sections.indexOf(name)
      return i >= 0 ? (sections[i + 1] ?? '').trim() : ''
    }
    return { sn: controller.sn, hostname: get('HOST'), uname: get('UNAME'), uptime: get('UPTIME'), release: get('RELEASE'), fwVersion: get('FW') }
  }

  async getMetrics(controller: Controller): Promise<Record<string, unknown>> {
    const r = await this.exec(
      controller,
      'echo LOAD; cat /proc/loadavg; echo MEM; free -m | sed -n "2p"; echo ROOT; df -h / | tail -1; echo MNT; df -h /mnt/data 2>/dev/null | tail -1'
    )
    const parts = r.stdout.split(/^(LOAD|MEM|ROOT|MNT)$/m)
    const get = (name: string) => { const i = parts.indexOf(name); return i >= 0 ? (parts[i + 1] ?? '').trim() : '' }
    const load = get('LOAD').split(/\s+/)
    const mem = get('MEM').split(/\s+/)
    const root = get('ROOT').split(/\s+/)
    const mnt = get('MNT').split(/\s+/)
    return {
      loadAvg: { one: parseFloat(load[0] || '0'), five: parseFloat(load[1] || '0'), fifteen: parseFloat(load[2] || '0') },
      memMiB: { total: parseInt(mem[1] || '0', 10), used: parseInt(mem[2] || '0', 10), free: parseInt(mem[3] || '0', 10) },
      diskRoot: { total: root[1] || '', used: root[2] || '', free: root[3] || '', usePct: root[4] || '' },
      diskMntData: mnt[1] ? { total: mnt[1], used: mnt[2] || '', free: mnt[3] || '', usePct: mnt[4] || '' } : null
    }
  }

  async jobStart(controller: Controller, command: string, label?: string): Promise<{ jobId: string; startedAt: string }> {
    if (!command.trim()) throw new Error('jobStart: empty command')
    // gc old jobs (best effort)
    void this.exec(controller,
      `find ${JOB_DIR} -maxdepth 1 -type f -mmin +${Math.floor(JOB_TTL_SEC / 60)} -delete 2>/dev/null || true`,
      5000
    ).catch(() => {})
    const jobId = Math.random().toString(16).slice(2, 10).padStart(8, '0').slice(0, 8)
    const unit = JOB_UNIT_PREFIX + jobId
    await this.exec(controller, `mkdir -p ${JOB_DIR}`)
    const scriptPath = `${JOB_DIR}/${jobId}.sh`
    const logPath = `${JOB_DIR}/${jobId}.log`
    const scriptContent = `#!/bin/bash\nset -o pipefail\n${command}\n`
    await this.writeFile(controller, scriptPath, scriptContent)
    if (label) await this.writeFile(controller, `${JOB_DIR}/${jobId}.label`, label)
    await this.exec(controller, `chmod +x '${scriptPath}'`)
    const descr = `'wb-ai-job ${jobId}${label ? ' ' + label.slice(0, 80) : ''}'`
    const runCmd =
      `date +%s > ${JOB_DIR}/${jobId}.started && ` +
      `systemd-run --unit=${unit} --collect --quiet ` +
      `--description=${descr} ` +
      `-p StandardOutput=append:${logPath} ` +
      `-p StandardError=append:${logPath} ` +
      `-p WorkingDirectory=/root ` +
      `/bin/bash ${scriptPath}`
    const r = await this.exec(controller, runCmd, 10_000)
    if (r.code !== 0) throw new Error(`systemd-run failed (${r.code}): ${r.stderr.trim() || r.stdout.trim()}`)
    return { jobId, startedAt: new Date().toISOString() }
  }

  async jobStatus(controller: Controller, jobId: string): Promise<Record<string, unknown>> {
    if (!/^[a-f0-9]{8}$/.test(jobId)) throw new Error(`jobStatus: invalid jobId ${jobId}`)
    const unit = JOB_UNIT_PREFIX + jobId
    const cmd =
      `systemctl show ${unit} -p ActiveState,Result,ExecMainStatus --no-pager 2>/dev/null; ` +
      `echo; echo ---; ` +
      `cat ${JOB_DIR}/${jobId}.sh 2>/dev/null | tail -n +3; ` +
      `echo; echo ---; ` +
      `cat ${JOB_DIR}/${jobId}.label 2>/dev/null; ` +
      `echo; echo ---; ` +
      `wc -c < ${JOB_DIR}/${jobId}.log 2>/dev/null || echo 0; ` +
      `wc -l < ${JOB_DIR}/${jobId}.log 2>/dev/null || echo 0; ` +
      `echo ---; ` +
      `cat ${JOB_DIR}/${jobId}.started 2>/dev/null || echo; ` +
      `stat -c %Y ${JOB_DIR}/${jobId}.log 2>/dev/null || echo`
    const r = await this.exec(controller, cmd, 10_000)
    const [showPart, cmdPart, labelPart, sizePart, tsPart] = r.stdout.split('\n---\n')
    const kv: Record<string, string> = {}
    for (const line of (showPart || '').split('\n')) {
      const i = line.indexOf('=')
      if (i > 0) kv[line.slice(0, i)] = line.slice(i + 1)
    }
    const activeState = kv['ActiveState'] ?? ''
    const result = kv['Result'] ?? ''
    void result // used for type narrowing awareness
    let state: 'running' | 'exited' | 'unknown' =
      (activeState === 'active' || activeState === 'activating') ? 'running' :
      (activeState === 'inactive' || activeState === 'failed' || activeState === 'deactivating') ? 'exited' : 'unknown'
    const tsLines = (tsPart || '').trim().split('\n')
    const startedUnix = parseInt(tsLines[0] || '', 10)
    const logMtimeUnix = parseInt(tsLines[1] || '', 10)
    if (state === 'unknown' && !isNaN(startedUnix) && startedUnix > 0) {
      state = 'exited'
    }
    const startedAt = (!isNaN(startedUnix) && startedUnix > 0) ? new Date(startedUnix * 1000).toISOString() : null
    const exitedAt = (state === 'exited' && !isNaN(logMtimeUnix) && logMtimeUnix > 0) ? new Date(logMtimeUnix * 1000).toISOString() : null
    const exitCodeRaw = kv['ExecMainStatus'] ?? ''
    const exitCode = state === 'exited' && exitCodeRaw !== '' ? parseInt(exitCodeRaw, 10) : 0
    const now = Date.now()
    const start = startedAt ? Date.parse(startedAt) : null
    const end = exitedAt ? Date.parse(exitedAt) : now
    const elapsedSec = start !== null && !isNaN(start) ? Math.max(0, Math.round((end - start) / 1000)) : null
    const sizeLines = (sizePart || '').trim().split('\n')
    const logBytes = parseInt(sizeLines[0] || '0', 10) || 0
    const logLines = parseInt(sizeLines[1] || '0', 10) || 0
    return { jobId, state, exitCode, label: (labelPart || '').trim() || null, command: (cmdPart || '').trim(), startedAt, exitedAt, elapsedSec, logBytes, logLines }
  }

  async jobTail(controller: Controller, jobId: string, fromLine = 1, maxLines = 500): Promise<Record<string, unknown>> {
    if (!/^[a-f0-9]{8}$/.test(jobId)) throw new Error(`jobTail: invalid jobId ${jobId}`)
    const n = Math.max(1, Math.min(maxLines, 1000))
    const from = Math.max(1, fromLine)
    const logPath = `${JOB_DIR}/${jobId}.log`
    const cmd = `wc -l < ${logPath} 2>/dev/null || echo 0; echo ---; sed -n '${from},$p' ${logPath} 2>/dev/null | head -n ${n}`
    const r = await this.exec(controller, cmd, 10_000)
    const [head, body] = r.stdout.split('\n---\n')
    const totalLines = parseInt((head || '0').trim(), 10) || 0
    const raw = (body ?? '').replace(/\n$/, '')
    const lines = raw === '' ? [] : raw.split('\n')
    const nextFromLine = from + lines.length
    return { jobId, lines, fromLine: from, nextFromLine, totalLines, truncated: from + lines.length - 1 < totalLines && lines.length >= n }
  }

  async jobCancel(controller: Controller, jobId: string): Promise<void> {
    if (!/^[a-f0-9]{8}$/.test(jobId)) throw new Error(`jobCancel: invalid jobId ${jobId}`)
    const unit = JOB_UNIT_PREFIX + jobId
    await this.exec(controller, `systemctl stop ${unit} 2>&1 || true`, 15_000)
  }

  async jobList(controller: Controller): Promise<Record<string, unknown>[]> {
    const cmd =
      `systemctl list-units --all --no-legend --no-pager '${JOB_UNIT_PREFIX}*.service' 2>/dev/null; ` +
      `echo ---; ` +
      `ls -1 ${JOB_DIR}/*.log 2>/dev/null | xargs -r -n1 basename | sed 's/\\.log$//'`
    const r = await this.exec(controller, cmd, 10_000)
    const [unitsPart, logsPart] = r.stdout.split('\n---\n')
    const ids = new Set<string>()
    for (const line of (unitsPart || '').split('\n')) {
      const m = line.match(new RegExp(`(${JOB_UNIT_PREFIX})([a-f0-9]{8})\\.service`))
      if (m && m[2]) ids.add(m[2])
    }
    for (const id of (logsPart || '').split('\n')) {
      const t = id.trim()
      if (/^[a-f0-9]{8}$/.test(t)) ids.add(t)
    }
    const entries: Record<string, unknown>[] = []
    for (const id of ids) {
      try {
        const st = await this.jobStatus(controller, id)
        entries.push(st)
      } catch { /* skip broken */ }
    }
    return entries.sort((a, b) => {
      if (a['state'] !== b['state']) return a['state'] === 'running' ? -1 : 1
      const ta = a['startedAt'] ? Date.parse(a['startedAt'] as string) : 0
      const tb = b['startedAt'] ? Date.parse(b['startedAt'] as string) : 0
      return tb - ta
    })
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
    // Always try the WB default password as last resort
    if (this.auth.password !== 'wirenboard') {
      out.push({ kind: 'password', password: 'wirenboard' })
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
    return {
      host,
      port: 22,
      username: this.auth.user || 'root',
      readyTimeout: CONNECT_TIMEOUT,
      hostVerifier: () => true,
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
