/**
 * Smart log truncation: keeps head + tail + warnings/errors with context.
 * Designed for apt/wb-release output where the middle is noise but
 * warnings and errors must never be dropped.
 */

const HEAD_LINES = 20
const TAIL_LINES = 300
const ERROR_CONTEXT = 20 // lines before and after each warning/error

const ERROR_PATTERNS = [
  /\berr(or)?\b/i,
  /\bwarn(ing)?\b/i,
  /\bfail(ed|ure)?\b/i,
  /\bE:\s/,          // apt error format
  /\bW:\s/,          // apt warning format
  /\bdpkg.*error/i,
  /\bunable\s+to/i,
  /\bcannot\b/i,
  /\bdenied\b/i,
  /\btimeout\b/i,
  /\babort/i,
  /\bsegfault/i,
  /\bkilled\b/i,
  /\boomkill/i,
  /\bno space/i,
  /\bcorrupt/i,
]

export function truncateLog(raw: string): string {
  const lines = raw.split('\n')
  const total = lines.length

  // Short output — return as is
  if (total <= HEAD_LINES + TAIL_LINES + 10) {
    return raw
  }

  // Find error/warning lines in the middle (between head and tail)
  const middleStart = HEAD_LINES
  const middleEnd = total - TAIL_LINES
  const errorLineNums = new Set<number>()

  for (let i = middleStart; i < middleEnd; i++) {
    if (ERROR_PATTERNS.some(p => p.test(lines[i]!))) {
      // Add the error line + context
      for (let j = Math.max(middleStart, i - ERROR_CONTEXT); j <= Math.min(middleEnd - 1, i + ERROR_CONTEXT); j++) {
        errorLineNums.add(j)
      }
    }
  }

  // Build output
  const result: string[] = []

  // Head
  result.push(...lines.slice(0, HEAD_LINES))

  if (errorLineNums.size > 0) {
    // Sort error line numbers and group into ranges
    const sorted = [...errorLineNums].sort((a, b) => a - b)
    let prevEnd = HEAD_LINES

    for (let idx = 0; idx < sorted.length; idx++) {
      const lineNum = sorted[idx]!
      // Gap between previous block and this line
      if (lineNum > prevEnd + 1) {
        const skipped = lineNum - prevEnd
        result.push(`\n... (пропущено ${skipped} строк) ...\n`)
      }
      result.push(lines[lineNum]!)
      prevEnd = lineNum + 1

      // If next line is not consecutive, close this block
      if (idx === sorted.length - 1 || sorted[idx + 1]! > lineNum + 1) {
        prevEnd = lineNum + 1
      }
    }

    // Gap before tail
    const skippedBeforeTail = middleEnd - prevEnd
    if (skippedBeforeTail > 0) {
      result.push(`\n... (пропущено ${skippedBeforeTail} строк) ...\n`)
    }
  } else {
    // No errors in middle — just note the gap
    const skipped = middleEnd - middleStart
    result.push(`\n... (пропущено ${skipped} строк без ошибок и предупреждений; для поиска в них используй grep/sed/awk) ...\n`)
  }

  // Tail
  result.push(...lines.slice(middleEnd))

  return result.join('\n')
}
