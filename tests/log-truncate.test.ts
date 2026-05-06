import { describe, test, expect } from 'bun:test'
import { truncateLog } from '../src/server/log-truncate.ts'

function makeLines(n: number, prefix = 'line'): string {
  return Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`).join('\n')
}

function makeLinesWithError(total: number, errorAt: number, errorText = 'ERROR: something failed'): string {
  const lines = Array.from({ length: total }, (_, i) =>
    i === errorAt ? errorText : `normal line ${i + 1}`
  )
  return lines.join('\n')
}

describe('truncateLog', () => {
  test('short output returned verbatim', () => {
    const short = makeLines(100)
    expect(truncateLog(short)).toBe(short)
  })

  test('exactly at threshold returned verbatim', () => {
    // HEAD_LINES(20) + TAIL_LINES(300) + 10 = 330
    const exact = makeLines(330)
    expect(truncateLog(exact)).toBe(exact)
  })

  test('over threshold triggers truncation', () => {
    const over = makeLines(500)
    const result = truncateLog(over)
    expect(result).toContain('пропущено')
    expect(result.length).toBeLessThan(over.length)
  })

  test('preserves head (first 20 lines)', () => {
    const result = truncateLog(makeLines(500))
    for (let i = 1; i <= 20; i++) {
      expect(result).toContain(`line ${i}`)
    }
  })

  test('preserves tail (last 300 lines)', () => {
    const result = truncateLog(makeLines(500))
    for (let i = 201; i <= 500; i++) {
      expect(result).toContain(`line ${i}`)
    }
  })

  test('no errors in middle produces single gap marker', () => {
    const result = truncateLog(makeLines(500))
    const gaps = result.match(/пропущено/g)
    expect(gaps).toHaveLength(1)
    expect(result).toContain('без ошибок')
  })

  test('error in middle is preserved with context', () => {
    // error at line 150 (0-indexed) in 500-line output
    const result = truncateLog(makeLinesWithError(500, 150))
    expect(result).toContain('ERROR: something failed')
  })

  test('multiple error patterns recognized', () => {
    const lines = Array.from({ length: 500 }, (_, i) => `normal ${i}`)
    lines[100] = 'E: Package not found'
    lines[150] = 'W: Some warning here'
    lines[180] = 'fatal error occurred'
    const result = truncateLog(lines.join('\n'))
    expect(result).toContain('E: Package not found')
    expect(result).toContain('W: Some warning here')
    expect(result).toContain('fatal error occurred')
  })

  test('error at start of middle preserved', () => {
    // middle starts at line 20 (0-indexed)
    const result = truncateLog(makeLinesWithError(500, 20))
    expect(result).toContain('ERROR: something failed')
  })

  test('gap count matches distinct error regions', () => {
    // Two errors far apart should produce gaps between them
    const lines = Array.from({ length: 1000 }, (_, i) => `line ${i}`)
    lines[100] = 'error at 100'
    lines[500] = 'error at 500'
    const result = truncateLog(lines.join('\n'))
    const gaps = result.match(/пропущено/g)
    // head → gap → error-100-block → gap → error-500-block → gap → tail (up to 3 gaps)
    expect(gaps!.length).toBeGreaterThanOrEqual(2)
  })
})
