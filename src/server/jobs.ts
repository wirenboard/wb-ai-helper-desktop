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
 * Фоновый трекер running-задач. Раз в `intervalMs` дёргает `getStatus(j)`
 * для каждой running-job и обновляет state. Никогда не выкидывает —
 * SSH-ошибка (контроллер перезагружается, sshd не отвечает) трактуется
 * как «состояние неизвестно, оставляем running, попробуем снова».
 *
 * Отвязан от UI polling: UI читает только in-memory state и не висит
 * на SSH handshake-таймаутах. Состояние «running → exited» приходит
 * сюда в фоне; UI следующим тиком видит его и поднимает баннер
 * «завершена».
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
          // транзиент: оставляем как есть, попробуем на следующем тике
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
