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
