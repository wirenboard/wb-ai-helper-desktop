export interface TrackedJob {
  jobId: string
  sn: string
  label: string
  sessionId: string
  state: 'running' | 'exited' | 'unknown'
}

const jobs = new Map<string, TrackedJob>()

export function trackJob(sessionId: string, jobId: string, sn: string, label: string): void {
  jobs.set(jobId, { jobId, sn, label, sessionId, state: 'running' })
}

export function getRunningJobForSn(sn: string): TrackedJob | null {
  for (const j of jobs.values()) {
    if (j.sn === sn && j.state === 'running') return j
  }
  return null
}

export function updateJobState(jobId: string, state: TrackedJob['state']): void {
  const j = jobs.get(jobId)
  if (j) j.state = state
}

export function getJobsForSession(sessionId: string): TrackedJob[] {
  return [...jobs.values()].filter((j) => j.sessionId === sessionId)
}

export function getAllJobs(): TrackedJob[] {
  return [...jobs.values()]
}

export function removeJob(jobId: string): void {
  jobs.delete(jobId)
}

/**
 * Background tracker for running jobs. Every `intervalMs` calls `getStatus(j)`
 * for each running job and updates state. Never throws — an SSH error
 * (controller rebooting, sshd unresponsive) is treated as "state unknown, keep
 * running, retry later".
 *
 * Decoupled from UI polling: the UI reads only in-memory state and never hangs
 * on SSH handshake timeouts. The "running → exited" transition lands here in
 * the background; the UI sees it on the next tick and raises the "finished"
 * banner.
 */
let trackerTimer: ReturnType<typeof setInterval> | null = null
export function startJobTracker(
  getStatus: (job: TrackedJob) => Promise<TrackedJob['state'] | null>,
  intervalMs = 5000,
): void {
  if (trackerTimer) return
  trackerTimer = setInterval(async () => {
    const running = [...jobs.values()].filter((j) => j.state === 'running')
    if (!running.length) return
    await Promise.all(
      running.map(async (j) => {
        try {
          const next = await getStatus(j)
          if (next === 'exited' || next === 'running') updateJobState(j.jobId, next)
        } catch {
          // transient: leave as-is, retry next tick
        }
      }),
    )
  }, intervalMs)
}

export function stopJobTracker(): void {
  if (trackerTimer) {
    clearInterval(trackerTimer)
    trackerTimer = null
  }
}
