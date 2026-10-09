// Text helpers shared by the compressors.

export const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Z0-9]/g
export const LONG_LINE = 400
export const IMPORTANT =
  /\b(?:error|errors|err|failed|failure|failing|fail|fatal|panic|panicked|exception|traceback|warning|warn|denied|refused|forbidden|not found|no such file|cannot|can't|unable|undefined|segmentation fault|assert(?:ion)?|expected|received|timeout|timed out|abort(?:ed)?|killed|exit code|exited with)\b|ERR!|✗|✘|×|FAIL|^\s*at \S+ \(|^\s*File ".*", line \d+|^\s*-->\s|^\s*\^+\s*$|^\s*\d+ (?:passed|failed|tests?)\b|^(?:Tests?|Test Suites|Ran \d+)/i
// errors outrank warnings: a run's failure must never lose its place to deprecation noise
export const CRITICAL =
  /\b(?:error|errors|failed|failure|failing|fatal|panic|panicked|exception|traceback|denied|refused|forbidden|not found|no such file|cannot|can't|unable|segmentation fault|assert(?:ion)?|expected|received|timeout|timed out|abort(?:ed)?|killed|exit code|exited with)\b|ERR!|✗|✘|✕|FAIL|●|^\s*at \S+ \(|^\s*File ".*", line \d+|^\s*-->\s|^\s*\^+\s*$|^\s*>\s*\d+\s*\|/i
// a passing line is never an error, whatever its name says (errorHandler.test.ts)
const PASSING = /^\s*(?:PASS\s|✓|✔|ok\s|PASSED\b)|\sPASSED\b|\.\.\. ok$/

// \b does not see Cyrillic letters, so Russian logs get their own words
const CRITICAL_RU = /ошибк|не удалось|невозможно|исключени|сбой|аварийн|отказано|не найден/i
const WARNING_RU = /предупрежд|устарел/i

export const levelOf = (line: string): 0 | 1 | 2 =>
  PASSING.test(line) ? 0 : CRITICAL.test(line) || CRITICAL_RU.test(line) ? 2 : IMPORTANT.test(line) || WARNING_RU.test(line) ? 1 : 0
/** Strips colors and cursor codes, keeps the last frame of `\r` progress lines. */
export const normalize = (text: string): string[] =>
  text
    .replace(ANSI, '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map(line => {
      const cr = line.lastIndexOf('\r')
      return (cr >= 0 ? line.slice(cr + 1) : line).trimEnd()
    })

export const clip = (line: string, max = LONG_LINE) =>
  line.length > max ? `${line.slice(0, Math.round(max * 0.75))} … [+${line.length - Math.round(max * 0.75)} chars]` : line

export const plural = (n: number, word: string) =>
  `${n.toLocaleString('en-US')} ${n === 1 ? word : /(?:ch|sh|s|x)$/.test(word) ? `${word}es` : /[^aeiou]y$/.test(word) ? `${word.slice(0, -1)}ies` : `${word}s`}`

