// Digests that know one tool's output: where its failures, errors and summary
// are, and what is noise. Each parser marks line ranges by rank; renderMarks
// keeps the highest ranks that fit (failures and summaries first, the latest
// first within a rank) and cuts the rest.

import { clip, plural } from './text'

export type ToolKind = 'jest' | 'node-test' | 'pytest' | 'go-test' | 'cargo' | 'tsc' | 'eslint' | 'install' | 'docker'

/** A range of lines, `to` exclusive. Rank 3: failures, errors, summaries; 2: context; 1: noise worth one example. */
export type Mark = { from: number; to: number; rank: 1 | 2 | 3 }

type Parsed = { kind: ToolKind; header: string; marks: Mark[]; kept: string }
type Parser = (lines: string[], command: string) => Parsed | undefined

const count = (lines: string[], re: RegExp) => lines.reduce((n, l) => n + (re.test(l) ? 1 : 0), 0)

/** The index after a block that starts at `from`, ends before `stop` matches, and is at most `cap` long. */
const until = (lines: string[], from: number, stop: (line: string) => boolean, cap: number) => {
  let k = from
  while (k < lines.length && k - from < cap && !stop(lines[k] ?? '')) k += 1
  return k
}

/** Marks the first `limit` lines of each kind of noise once, and counts every kind. */
const once = () => {
  const seen = new Map<string, number>()
  return {
    isFirst: (key: string) => {
      const n = (seen.get(key) ?? 0) + 1
      seen.set(key, n)
      return n === 1
    },
    summary: (word: string) => {
      const total = [...seen.values()].reduce((a, b) => a + b, 0)
      return total ? `${plural(total, word)} of ${plural(seen.size, 'kind')}` : ''
    },
  }
}

const TEST_SUMMARY = /^\s*(?:Test Suites:|Tests:|Snapshots:|Time:|Ran all test suites|Test Files\s|Tests\s+\d|Duration\s|Start at\s)/

const jest: Parser = (lines, command) => {
  const passFail = count(lines, /^\s*(?:PASS|FAIL)\s+\S/)
  const vitest = count(lines, /^\s*(?:✓|❯|×)\s+\S/)
  if (passFail < 3 && vitest < 3 && !(/\b(?:jest|vitest)\b/.test(command) && lines.some(l => TEST_SUMMARY.test(l)))) return undefined
  const marks: Mark[] = [{ from: 0, to: Math.min(2, lines.length), rank: 2 }]
  const noise = once()
  let passed = 0
  let failed = 0
  const isBoundary = (l: string) => /^\s*(?:PASS|FAIL)\s+\S/.test(l) || /^\s*●\s/.test(l) || /^\s*✓\s/.test(l) || TEST_SUMMARY.test(l) || /^Summary of all failing/.test(l.trim())
  for (let k = 0; k < lines.length; k += 1) {
    const l = lines[k] ?? ''
    if (/^\s*PASS\s/.test(l) || /^\s*✓\s/.test(l)) passed += 1
    if (/^\s*FAIL\s/.test(l) || /^\s*●\s/.test(l) || /^\s*(?:×|✕|❯)\s/.test(l)) {
      if (/^\s*FAIL\s/.test(l) || /^\s*❯\s/.test(l)) failed += 1
      marks.push({ from: k, to: until(lines, k + 1, isBoundary, 60), rank: 3 })
    } else if (TEST_SUMMARY.test(l)) {
      marks.push({ from: k, to: k + 1, rank: 3 })
    } else if (/^Summary of all failing tests/.test(l.trim())) {
      marks.push({ from: k, to: until(lines, k + 1, x => /^\s*Test Suites:/.test(x), 200), rank: 3 })
    } else if (/^\s*console\.(?:warn|error|log|info|debug)\b/.test(l)) {
      const message = /console\.\w+\s*$/.test(l) ? (lines[k + 1] ?? '') : l
      if (noise.isFirst(message.replace(/\d+/g, '#').trim())) marks.push({ from: k, to: Math.min(lines.length, k + (/console\.\w+\s*$/.test(l) ? 2 : 1)), rank: 1 })
    }
  }
  const consoleLines = noise.summary('console line')
  return {
    kind: 'jest',
    header: `[${vitest >= 3 ? 'vitest' : 'jest'}] ${plural(passed, 'passing file')} not listed, ${failed} failing${consoleLines ? `; ${consoleLines}, one of each shown` : ''}`,
    marks,
    kept: 'every failure with its message and code frame, the summary',
  }
}

const nodeTest: Parser = lines => {
  if (count(lines, /^\s*[✔✖] /) < 3 || !lines.some(l => /^ℹ (?:tests|pass|fail) \d+/.test(l))) return undefined
  const marks: Mark[] = []
  let passed = 0
  for (let k = 0; k < lines.length; k += 1) {
    const l = lines[k] ?? ''
    if (/^\s*✔ /.test(l)) passed += 1
    if (/^\s*✖ /.test(l)) marks.push({ from: k, to: until(lines, k + 1, x => /^\s*[✔✖] |^ℹ /.test(x), 40), rank: 3 })
    if (/^ℹ /.test(l)) marks.push({ from: k, to: k + 1, rank: 3 })
    if (/^✖ failing tests:/.test(l)) marks.push({ from: k, to: until(lines, k + 1, x => /^ℹ /.test(x), 200), rank: 3 })
  }
  return { kind: 'node-test', header: `[node --test] ${plural(passed, 'passing test')} not listed`, marks, kept: 'every failing test with its error, the summary' }
}

const pytest: Parser = (lines, command) => {
  const isPytest = lines.some(l => /^=+ test session starts =+$/.test(l)) || count(lines, /::\S+ (?:PASSED|FAILED|ERROR)/) >= 3 || (/\bpytest\b/.test(command) && lines.some(l => /\d+ (?:passed|failed)/.test(l)))
  if (!isPytest) return undefined
  const marks: Mark[] = [{ from: 0, to: Math.min(4, lines.length), rank: 2 }]
  const sections = lines.map((l, k) => (/^=+ .+ =+$/.test(l) ? k : -1)).filter(k => k >= 0)
  for (let s = 0; s < sections.length; s += 1) {
    const start = sections[s] ?? 0
    const end = sections[s + 1] ?? lines.length
    const title = lines[start] ?? ''
    if (/FAILURES|ERRORS/.test(title)) {
      marks.push({ from: start, to: start + 1, rank: 3 })
      const blocks = [...Array(end - start).keys()].map(i => start + i).filter(k => /^_+ .+ _+$/.test(lines[k] ?? ''))
      for (let b = 0; b < blocks.length; b += 1) {
        const from = blocks[b] ?? start
        const to = blocks[b + 1] ?? end
        if (to - from <= 52) marks.push({ from, to, rank: 3 })
        else marks.push({ from, to: from + 40, rank: 3 }, { from: to - 12, to, rank: 3 })
      }
    } else if (/short test summary/.test(title)) {
      marks.push({ from: start, to: end, rank: 3 })
    } else if (/warnings summary/.test(title)) {
      marks.push({ from: start, to: Math.min(end, start + 15), rank: 1 })
    } else if (/\d+ (?:passed|failed|error|skipped|deselected)/.test(title)) {
      marks.push({ from: start, to: start + 1, rank: 3 })
    }
  }
  lines.forEach((l, k) => {
    if (/ (?:FAILED|ERROR)\b/.test(l) && !/^=+/.test(l)) marks.push({ from: k, to: k + 1, rank: 2 })
  })
  const passed = count(lines, / PASSED\b/)
  return { kind: 'pytest', header: `[pytest]${passed ? ` ${plural(passed, 'PASSED line')} not listed;` : ''} failures, errors and the summary below`, marks, kept: 'the session header, every failure (long ones by their start and end), the short summary' }
}

const goTest: Parser = (lines, command) => {
  if (count(lines, /^(?:=== RUN|--- (?:PASS|FAIL|SKIP)|ok\s+\S+|FAIL\s+\S+|PASS$)/) < 3 && !/\bgo test\b/.test(command)) return undefined
  if (!lines.some(l => /^(?:--- |ok\s|FAIL|PASS$|panic:)/.test(l))) return undefined
  const marks: Mark[] = []
  let ok = 0
  const runAt = new Map<string, number>()
  for (let k = 0; k < lines.length; k += 1) {
    const l = lines[k] ?? ''
    const run = /^=== RUN\s+(\S+)/.exec(l)
    if (run?.[1]) runAt.set(run[1], k)
    if (/^ok\s/.test(l)) ok += 1
    const fail = /^\s*--- FAIL: (\S+)/.exec(l)
    if (fail) {
      const started = fail[1] ? runAt.get(fail[1]) : undefined
      if (started !== undefined && k - started < 40) marks.push({ from: started, to: k, rank: 3 })
      marks.push({ from: k, to: until(lines, k + 1, x => /^(?:=== RUN|\s*--- |ok\s|FAIL\s|FAIL$|PASS$)/.test(x), 60), rank: 3 })
    }
    if (/^panic:|^fatal error:/.test(l)) marks.push({ from: k, to: Math.min(lines.length, k + 40), rank: 3 })
    if (/^FAIL(?:\s|$)/.test(l) || /^\S+\.go:\d+:\d+: /.test(l)) marks.push({ from: k, to: k + 1, rank: 3 })
  }
  const passed = count(lines, /^\s*--- PASS/)
  return { kind: 'go-test', header: `[go test] ${plural(ok, 'package')} ok${passed ? `, ${plural(passed, 'passing test')}` : ''} not listed`, marks, kept: 'every failing test with its log, panics, build errors, FAIL lines' }
}

const cargo: Parser = (lines, command) => {
  const steps = count(lines, /^\s*(?:Compiling|Checking|Downloaded|Downloading|Fresh|Documenting)\s/)
  if (steps < 3 && !(/\bcargo\b/.test(command) && lines.some(l => /^(?:error|warning)(?:\[\w+\])?: |^test result: /.test(l)))) return undefined
  const marks: Mark[] = []
  const warnings = once()
  for (let k = 0; k < lines.length; k += 1) {
    const l = lines[k] ?? ''
    if (/^error(?:\[\w+\])?: /.test(l)) marks.push({ from: k, to: until(lines, k + 1, x => x.trim() === '' || /^(?:error|warning)/.test(x), 30), rank: 3 })
    const w = /^warning: (.+)$/.exec(l)
    if (w?.[1] && warnings.isFirst(w[1].replace(/`[^`]*`/g, '`…`').replace(/\d+/g, '#'))) marks.push({ from: k, to: until(lines, k + 1, x => x.trim() === '' || /^(?:error|warning)/.test(x), 10), rank: 1 })
    if (/^test result: |^test .* \.\.\. FAILED$|^error: test failed/.test(l)) marks.push({ from: k, to: k + 1, rank: 3 })
    if (/^failures:$/.test(l)) marks.push({ from: k, to: until(lines, k + 1, x => /^test result: /.test(x), 80), rank: 3 })
    if (/^---- .+ stdout ----$/.test(l)) marks.push({ from: k, to: until(lines, k + 1, x => /^---- |^failures:$|^test result/.test(x), 30), rank: 3 })
  }
  marks.push({ from: Math.max(0, lines.length - 2), to: lines.length, rank: 2 })
  const w = warnings.summary('warning')
  return { kind: 'cargo', header: `[cargo] ${plural(steps, 'compile/download line')} not listed${w ? `; ${w}, one of each shown` : ''}`, marks, kept: 'every error with its source snippet, one example of each warning, test failures and results' }
}

const TSC = /^(.+?)\((\d+),(\d+)\): error (TS\d+): |^(.+?):(\d+):(\d+) - error (TS\d+): /

const tsc: Parser = (lines, command) => {
  const errors = count(lines, TSC)
  if (errors === 0 || (errors < 2 && !/\btsc\b|type-?check/.test(command))) return undefined
  const marks: Mark[] = []
  const files = new Set<string>()
  for (let k = 0; k < lines.length; k += 1) {
    const m = TSC.exec(lines[k] ?? '')
    if (m) {
      const file = m[1] ?? m[5] ?? ''
      const isPretty = Boolean(m[5])
      marks.push({ from: k, to: isPretty ? until(lines, k + 1, x => x.trim() === '' || TSC.test(x), 6) : k + 1, rank: files.has(file) ? 2 : 3 })
      files.add(file)
    }
    if (/^Found \d+ errors?/.test(lines[k] ?? '')) marks.push({ from: k, to: k + 1, rank: 3 })
  }
  return { kind: 'tsc', header: `[tsc] ${plural(errors, 'error')} in ${plural(files.size, 'file')}`, marks, kept: 'the first error in every file, then the rest as they fit, the total' }
}

const eslint: Parser = lines => {
  const problem = /^\s+\d+:\d+\s+(error|warning)\s+.*?\s{2,}(\S+)\s*$/
  if (count(lines, problem) < 2) return undefined
  const marks: Mark[] = []
  const rules = new Map<string, number>()
  let file = -1
  let errors = 0
  let warnings = 0
  for (let k = 0; k < lines.length; k += 1) {
    const l = lines[k] ?? ''
    if (/^\S/.test(l) && !/^✖|^\d+ problems?/.test(l)) file = k
    const m = problem.exec(l)
    if (m) {
      const rule = m[2] ?? ''
      rules.set(rule, (rules.get(rule) ?? 0) + 1)
      if (m[1] === 'error') errors += 1
      else warnings += 1
      const rank = m[1] === 'error' ? 3 : rules.get(rule) === 1 ? 1 : 0
      if (rank) {
        if (file >= 0) marks.push({ from: file, to: file + 1, rank })
        marks.push({ from: k, to: k + 1, rank })
      }
    }
    if (/^✖ \d+ problems?|potentially fixable/.test(l)) marks.push({ from: k, to: k + 1, rank: 3 })
  }
  const top = [...rules.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([r, n]) => `${r} ×${n}`).join(', ')
  return { kind: 'eslint', header: `[eslint] ${plural(errors, 'error')}, ${plural(warnings, 'warning')}; most frequent rules: ${top}`, marks, kept: 'every error, one example of each warning rule, the totals' }
}

const install: Parser = (lines, command) => {
  const signs = count(lines, /^npm (?:WARN|ERR!|notice|warn|error)|^(?:added|removed|changed|audited) \d+ packages?|^\s*(?:Collecting|Downloading|Installing collected packages|Successfully installed|Requirement already satisfied|Using cached|Building wheel)|^Progress: resolved|^Packages: |^warning .*: |^\[\d\/\d\] /)
  if (signs < 3 && !/\b(?:npm|yarn|pnpm|bun)\s+(?:i|install|ci|add)\b|\bpip3?\s+install\b|\buv\s+(?:pip|sync|add)\b/.test(command)) return undefined
  if (signs < 1) return undefined
  const marks: Mark[] = []
  const warnings = once()
  let downloads = 0
  for (let k = 0; k < lines.length; k += 1) {
    const l = lines[k] ?? ''
    if (/ERR!|^npm error|^ERROR:|^error\b|^\s*×\s|failed with exit code|ResolutionImpossible/i.test(l)) marks.push({ from: k, to: Math.min(lines.length, k + 4), rank: 3 })
    const w = /^(?:npm (?:WARN|warn)|warning|WARNING:?)\s+(\S+)/.exec(l)
    if (w?.[1] && warnings.isFirst(w[1])) marks.push({ from: k, to: k + 1, rank: 1 })
    if (/^\s*(?:Collecting|Downloading|Using cached|Requirement already satisfied)/.test(l)) downloads += 1
    if (/^(?:added|removed|changed|audited|up to date)|vulnerabilit|^Successfully installed|^Done in|^Packages: |^run `npm fund`|^\d+ packages? are looking for funding/.test(l)) marks.push({ from: k, to: k + 1, rank: 3 })
  }
  const w = warnings.summary('warning')
  return { kind: 'install', header: `[install]${downloads ? ` ${plural(downloads, 'download line')} not listed;` : ''}${w ? ` ${w}, one of each shown` : ''}`, marks, kept: 'every error, one warning of each kind, the summary' }
}

const docker: Parser = (lines, command) => {
  if (count(lines, /^#\d+ /) < 5 && !(/\bdocker\b.*\bbuild\b/.test(command) && lines.some(l => /^#\d+ /.test(l)))) return undefined
  const marks: Mark[] = []
  const steps = new Set<string>()
  for (let k = 0; k < lines.length; k += 1) {
    const l = lines[k] ?? ''
    const step = /^#(\d+) \[/.exec(l)
    if (step?.[1] && !steps.has(step[1])) {
      steps.add(step[1])
      marks.push({ from: k, to: k + 1, rank: 2 })
    }
    if (/^#\d+ ERROR|^ERROR[: ]|failed to solve|did not complete successfully/.test(l)) marks.push({ from: k, to: Math.min(lines.length, k + 4), rank: 3 })
    if (/^------\s*$/.test(l)) {
      const end = until(lines, k + 1, x => /^------\s*$/.test(x), 40)
      marks.push({ from: k, to: Math.min(lines.length, end + 1), rank: 3 })
      k = end
    }
  }
  marks.push({ from: Math.max(0, lines.length - 4), to: lines.length, rank: 3 })
  return { kind: 'docker', header: `[docker build] ${plural(steps.size, 'step')}: headers kept, their output not shown`, marks, kept: 'every step header, the failing step with its output, the end' }
}

const PARSERS: Parser[] = [jest, nodeTest, pytest, goTest, cargo, tsc, eslint, install, docker]

/** Keeps the marked ranges by rank (latest first within a rank) within `target` and cuts the rest. */
export const renderMarks = (lines: string[], marks: Mark[], target: number, header: string) => {
  const keep = new Set<number>()
  let used = header.length + 1
  const order = [...marks].sort((a, b) => b.rank - a.rank || b.from - a.from)
  for (const m of order) {
    const limit = m.rank === 3 ? target * 1.5 : target
    for (let k = Math.max(0, m.from); k < Math.min(lines.length, m.to); k += 1) {
      if (keep.has(k)) continue
      const cost = clip(lines[k] ?? '').length + 1
      if (used + cost > limit) break
      keep.add(k)
      used += cost
    }
  }
  const out = header ? [header] : []
  let gap = 0
  for (let k = 0; k < lines.length; k += 1) {
    if (keep.has(k)) {
      if (gap) out.push(`… [${plural(gap, 'line')} cut] …`)
      gap = 0
      out.push(clip(lines[k] ?? ''))
    } else gap += 1
  }
  if (gap) out.push(`… [${plural(gap, 'line')} cut] …`)
  return out.join('\n')
}

/** A digest by the first parser that recognises the output, or undefined. */
export const digestTool = (lines: string[], command: string, target: number) => {
  for (const parse of PARSERS) {
    const parsed = parse(lines, command)
    if (parsed && parsed.marks.some(m => m.rank === 3)) {
      return { text: renderMarks(lines, parsed.marks, target, parsed.header), kind: parsed.kind, kept: parsed.kept }
    }
  }
  return undefined
}
