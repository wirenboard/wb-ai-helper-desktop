import { describe, test, expect, afterEach } from 'bun:test'
import {
  trackJob, getRunningJobForSn, updateJobState,
  getJobsForSession, getAllJobs, removeJob,
} from '../src/server/jobs.ts'

afterEach(() => {
  for (const j of getAllJobs()) removeJob(j.jobId)
})

describe('trackJob', () => {
  test('creates a running job', () => {
    trackJob('s1', 'j1', 'SN1', 'test job')
    const all = getAllJobs()
    expect(all).toHaveLength(1)
    expect(all[0]).toMatchObject({ jobId: 'j1', sn: 'SN1', label: 'test job', sessionId: 's1', state: 'running' })
  })
})

describe('getRunningJobForSn', () => {
  test('returns running job for SN', () => {
    trackJob('s1', 'j1', 'SN1', 'job1')
    expect(getRunningJobForSn('SN1')?.jobId).toBe('j1')
  })

  test('returns null for unknown SN', () => {
    trackJob('s1', 'j1', 'SN1', 'job1')
    expect(getRunningJobForSn('SN2')).toBeNull()
  })

  test('skips exited jobs', () => {
    trackJob('s1', 'j1', 'SN1', 'job1')
    updateJobState('j1', 'exited')
    expect(getRunningJobForSn('SN1')).toBeNull()
  })
})

describe('updateJobState', () => {
  test('changes state', () => {
    trackJob('s1', 'j1', 'SN1', 'job1')
    updateJobState('j1', 'exited')
    expect(getAllJobs()[0]?.state).toBe('exited')
  })

  test('no-op for unknown jobId', () => {
    updateJobState('nonexistent', 'exited')
    expect(getAllJobs()).toHaveLength(0)
  })
})

describe('getJobsForSession', () => {
  test('returns only jobs for given session', () => {
    trackJob('s1', 'j1', 'SN1', 'a')
    trackJob('s2', 'j2', 'SN2', 'b')
    trackJob('s1', 'j3', 'SN3', 'c')
    expect(getJobsForSession('s1')).toHaveLength(2)
    expect(getJobsForSession('s2')).toHaveLength(1)
  })

  test('returns empty for unknown session', () => {
    expect(getJobsForSession('unknown')).toHaveLength(0)
  })
})

describe('removeJob', () => {
  test('deletes a job', () => {
    trackJob('s1', 'j1', 'SN1', 'job1')
    removeJob('j1')
    expect(getAllJobs()).toHaveLength(0)
    expect(getRunningJobForSn('SN1')).toBeNull()
  })
})
