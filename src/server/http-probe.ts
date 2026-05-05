import type { Controller } from './discovery.ts'

const HTTP_TIMEOUT = 2500

export type ProbeResult = {
  reachable: boolean
  hostname?: string
  fw?: string
  webUiUrl: string
}

export async function probe(c: Controller): Promise<ProbeResult> {
  const webUiUrl = `http://${c.host}/`
  const ctrl = AbortSignal.timeout(HTTP_TIMEOUT)
  try {
    // Wirenboard exposes its web UI at root; we just check reachability + headers.
    const res = await fetch(webUiUrl, { signal: ctrl, redirect: 'follow' })
    if (!res.ok && res.status !== 401) return { reachable: false, webUiUrl }
    const server = res.headers.get('server') ?? ''
    return { reachable: true, webUiUrl, hostname: c.host, fw: server || undefined }
  } catch {
    return { reachable: false, webUiUrl }
  }
}
