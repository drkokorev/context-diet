// Context Diet's compressors: pure functions from a tool's raw output to a
// shorter text that keeps what an agent needs (errors, summaries, structure).
// Nothing here touches the engine, so the tests call these directly.

export type DietKind = 'log' | 'json' | 'diff' | 'grep' | 'paths' | 'table'

export type DietInput = {
  text: string
  tool: string
  /** Bash's command, when the output came from Bash */
  command?: string
  /** how many characters the shortened text should aim for */
  target: number
}

export type DietOutput = {
  text: string
  kind: DietKind
  /** what the shortened text kept, in a few words, for the note above it */
  kept: string
}

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Z0-9]/g
const LONG_LINE = 400
const IMPORTANT =
  /\b(?:error|errors|err|failed|failure|failing|fail|fatal|panic|panicked|exception|traceback|warning|warn|denied|refused|forbidden|not found|no such file|cannot|can't|unable|undefined|segmentation fault|assert(?:ion)?|expected|received|timeout|timed out|abort(?:ed)?|killed|exit code|exited with)\b|ERR!|✗|✘|×|FAIL|^\s*at \S+ \(|^\s*File ".*", line \d+|^\s*-->\s|^\s*\^+\s*$|^\s*\d+ (?:passed|failed|tests?)\b|^(?:Tests?|Test Suites|Ran \d+)/i
// errors outrank warnings: a run's failure must never lose its place to deprecation noise
const CRITICAL =
  /\b(?:error|errors|failed|failure|failing|fatal|panic|panicked|exception|traceback|denied|refused|forbidden|not found|no such file|cannot|can't|unable|segmentation fault|assert(?:ion)?|expected|received|timeout|timed out|abort(?:ed)?|killed|exit code|exited with)\b|ERR!|✗|✘|✕|FAIL|●|^\s*at \S+ \(|^\s*File ".*", line \d+|^\s*-->\s|^\s*\^+\s*$|^\s*>\s*\d+\s*\|/i
const levelOf = (line: string): 0 | 1 | 2 => (CRITICAL.test(line) ? 2 : IMPORTANT.test(line) ? 1 : 0)
const LOCKFILE =
  /(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|poetry\.lock|Pipfile\.lock|uv\.lock|composer\.lock|Gemfile\.lock|go\.sum|flake\.lock|Podfile\.lock|packages\.lock\.json)$|\.min\.(?:js|css)$|\.map$|(?:^|\/)(?:dist|build|vendor|node_modules|__snapshots__)\//

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

const clip = (line: string, max = LONG_LINE) =>
  line.length > max ? `${line.slice(0, Math.round(max * 0.75))} … [+${line.length - Math.round(max * 0.75)} chars]` : line

const plural = (n: number, word: string) =>
  `${n.toLocaleString('en-US')} ${n === 1 ? word : /(?:ch|sh|s|x)$/.test(word) ? `${word}es` : /[^aeiou]y$/.test(word) ? `${word.slice(0, -1)}ies` : `${word}s`}`

const isPathLike = (line: string) => /^\.{0,2}\/?[\w@.+~-][\w@.+~/ -]*$/.test(line) && !/\s{2,}/.test(line) && (line.includes('/') || /\.\w{1,8}$/.test(line))

export const detectKind = (text: string, tool: string, command?: string): DietKind => {
  const trimmed = text.trim()
  if ((trimmed.startsWith('{') || trimmed.startsWith('[')) && trimmed.length < 8_000_000) {
    try {
      JSON.parse(trimmed)
      return 'json'
    } catch {
      // not JSON after all
    }
  }
  if (/^diff --git /m.test(text) || (/^--- \S/m.test(text) && /^\+\+\+ \S/m.test(text) && /^@@ /m.test(text))) return 'diff'
  const lines = text.split('\n').filter(line => line.trim() !== '')
  if (lines.length < 20) return 'log'
  const grepLike = lines.filter(line => /^[^\s:]+[:-]\d+[:-]/.test(line) || line === '--').length
  if (tool === 'Grep' ? grepLike > lines.length * 0.5 : grepLike > lines.length * 0.7) return 'grep'
  const pathLike = lines.filter(line => isPathLike(line.trim())).length
  if (tool === 'Glob' || pathLike > lines.length * 0.85) return 'paths'
  if (isTable(lines)) return 'table'
  if (command && /^\s*(?:rg|grep|ag|ack)\b/.test(command) && grepLike > lines.length * 0.4) return 'grep'
  return 'log'
}

// ---------- logs ----------

const isWordy = (shape: string) => (shape.match(/[a-z]/gi)?.length ?? 0) >= 6

type Line = { text: string; level: 0 | 1 | 2 }

/** Folds runs of identical lines and of lines that differ only in numbers. */
export const collapseRuns = (lines: string[]): Line[] => {
  const shape = (line: string) => line.replace(/0x[0-9a-f]+|\d+(?:\.\d+)?/gi, '#').replace(/\s+/g, ' ').slice(0, 60)
  const out: Line[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i] ?? ''
    let j = i + 1
    while (j < lines.length && lines[j] === line) j += 1
    const same = j - i
    if (same >= 3) {
      out.push({ text: `${clip(line)}  [×${same}]`, level: levelOf(line) })
      i = j
      continue
    }
    const s = shape(line)
    j = i + 1
    // only lines with words fold as "similar": rows that differ in numbers alone are data
    while (j < lines.length && isWordy(s) && shape(lines[j] ?? '') === s) j += 1
    const similar = j - i
    if (similar >= 5) {
      const last = lines[j - 1] ?? ''
      const hit = Math.max(...lines.slice(i, j).map(levelOf)) as 0 | 1 | 2
      out.push({ text: clip(line), level: hit })
      out.push({ text: `  … ${plural(similar - 2, 'similar line')} …`, level: 0 })
      out.push({ text: clip(last), level: hit })
      i = j
      continue
    }
    out.push({ text: clip(line), level: levelOf(line) })
    i += 1
  }
  return out
}

const size = (lines: Line[]) => lines.reduce((n, l) => n + l.text.length + 1, 0)

export const dietLog = (text: string, target: number): DietOutput => {
  const raw = normalize(text)
  // drop blank-line runs
  const lines = raw.filter((line, i) => line !== '' || (raw[i - 1] ?? '') !== '')
  const folded = collapseRuns(lines)
  if (size(folded) <= target) return { text: folded.map(l => l.text).join('\n'), kind: 'log', kept: 'every line; repeats folded' }

  const errorHits = folded.map((l, i) => (l.level === 2 ? i : -1)).filter(i => i >= 0)
  const warnHits = folded.map((l, i) => (l.level === 1 ? i : -1)).filter(i => i >= 0)
  // with errors to show, spend less on the start and end of the run
  const headBudget = target * (errorHits.length ? 0.1 : 0.2)
  const tailBudget = target * (errorHits.length ? 0.25 : 0.35)
  const keep = new Set<number>()
  let used = 0
  for (let i = 0; i < folded.length && used < headBudget; i += 1) {
    keep.add(i)
    used += (folded[i]?.text.length ?? 0) + 1
  }
  let tailUsed = 0
  for (let i = folded.length - 1; i >= 0 && tailUsed < tailBudget; i -= 1) {
    if (!keep.has(i)) {
      keep.add(i)
      tailUsed += (folded[i]?.text.length ?? 0) + 1
    }
  }
  used += tailUsed
  // latest first: the last error is usually the one that matters
  const take = (hits: number[], before: number, after: number, isDeduped: boolean) => {
    const seen = new Set<string>()
    let shown = 0
    for (let h = hits.length - 1; h >= 0; h -= 1) {
      const at = hits[h] ?? 0
      const key = (folded[at]?.text ?? '').replace(/\d+/g, '#').trim()
      if (isDeduped && seen.has(key)) continue
      seen.add(key)
      const window: number[] = []
      for (let i = at - before; i <= at + after; i += 1) if (i >= 0 && i < folded.length && !keep.has(i)) window.push(i)
      const cost = window.reduce((n, i) => n + (folded[i]?.text.length ?? 0) + 1, 0)
      if (used + cost > target) continue
      window.forEach(i => keep.add(i))
      used += cost
      shown += 1
    }
    return { shown, kinds: seen.size }
  }
  const errors = take(errorHits, 2, 3, false)
  const warnings = take(warnHits, 0, 0, true)

  const out: string[] = []
  let gap = 0
  for (let i = 0; i < folded.length; i += 1) {
    if (keep.has(i)) {
      if (gap) out.push(`… [${plural(gap, 'line')} cut] …`)
      gap = 0
      out.push(folded[i]?.text ?? '')
    } else gap += 1
  }
  if (gap) out.push(`… [${plural(gap, 'line')} cut] …`)
  const parts = ['the first and last lines']
  if (errorHits.length) parts.push(`${errors.shown} of ${plural(errorHits.length, 'error line')} with context`)
  if (warnHits.length) parts.push(`${warnings.shown} of ${plural(warnings.kinds, 'distinct warning')}`)
  return { text: out.join('\n'), kind: 'log', kept: `${parts.join(', ')}; repeats folded` }
}

// ---------- JSON ----------

type Shape = { depth: number; items: number; keys: number; str: number }

const SHAPES: Shape[] = [
  { depth: 6, items: 3, keys: 40, str: 160 },
  { depth: 5, items: 2, keys: 25, str: 100 },
  { depth: 4, items: 1, keys: 15, str: 60 },
  { depth: 3, items: 1, keys: 10, str: 40 },
  { depth: 2, items: 1, keys: 8, str: 30 },
]

const skeleton = (value: unknown, shape: Shape, depth = 0): unknown => {
  if (typeof value === 'string') return value.length > shape.str ? `${value.slice(0, shape.str)}…(+${value.length - shape.str} chars)` : value
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) {
    if (depth >= shape.depth) return `[… ${plural(value.length, 'item')}]`
    if (value.length <= shape.items + 1) return value.map(v => skeleton(v, shape, depth + 1))
    const head = value.slice(0, shape.items).map(v => skeleton(v, shape, depth + 1))
    const objects = value.filter(v => v !== null && typeof v === 'object' && !Array.isArray(v)) as Record<string, unknown>[]
    const keys = [...new Set(objects.flatMap(o => Object.keys(o)))]
    const more = `… ${plural(value.length - shape.items, 'more item')}${keys.length && objects.length === value.length ? ` (keys: ${keys.slice(0, 20).join(', ')}${keys.length > 20 ? ', …' : ''})` : ''}`
    return [...head, more]
  }
  const entries = Object.entries(value as Record<string, unknown>)
  if (depth >= shape.depth) return `{… ${plural(entries.length, 'key')}: ${entries.slice(0, 8).map(([k]) => k).join(', ')}${entries.length > 8 ? ', …' : ''}}`
  const out: Record<string, unknown> = {}
  for (const [k, v] of entries.slice(0, shape.keys)) out[k] = skeleton(v, shape, depth + 1)
  if (entries.length > shape.keys) out['…'] = `${entries.length - shape.keys} more keys: ${entries.slice(shape.keys, shape.keys + 12).map(([k]) => k).join(', ')}${entries.length > shape.keys + 12 ? ', …' : ''}`
  return out
}

export const dietJson = (text: string, target: number): DietOutput => {
  const value = JSON.parse(text.trim()) as unknown
  let out = ''
  for (const shape of SHAPES) {
    out = JSON.stringify(skeleton(value, shape), null, 1)
    if (out.length <= target) break
  }
  const what = Array.isArray(value) ? `an array of ${plural(value.length, 'item')}` : value && typeof value === 'object' ? `an object with ${plural(Object.keys(value).length, 'key')}` : 'a value'
  return { text: out, kind: 'json', kept: `the structure of ${what}: every key, the first items of each array, strings shortened` }
}

// ---------- diffs ----------

export const dietDiff = (text: string, target: number): DietOutput => {
  const lines = normalize(text)
  const files: { name: string; lines: string[] }[] = []
  let cur: { name: string; lines: string[] } = { name: '', lines: [] }
  for (const line of lines) {
    const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line)
    if (m) {
      if (cur.lines.length) files.push(cur)
      cur = { name: m[2] ?? m[1] ?? '', lines: [line] }
      continue
    }
    if (!cur.name) {
      const p = /^\+\+\+ (?:b\/)?(.+)$/.exec(line)
      if (p && p[1] !== '/dev/null') cur.name = p[1] ?? ''
    }
    cur.lines.push(line)
  }
  if (cur.lines.length) files.push(cur)

  const counts = (body: string[]) => ({
    add: body.filter(l => l.startsWith('+') && !l.startsWith('+++')).length,
    del: body.filter(l => l.startsWith('-') && !l.startsWith('---')).length,
  })
  const generated = files.filter(f => LOCKFILE.test(f.name))
  const real = files.filter(f => !LOCKFILE.test(f.name))
  const perFile = Math.max(600, Math.floor((target - generated.length * 90) / Math.max(1, real.length)))
  const out: string[] = []
  let cutFiles = 0
  for (const f of files) {
    const { add, del } = counts(f.lines)
    if (LOCKFILE.test(f.name)) {
      out.push(`${f.lines[0] ?? f.name}\n  [lockfile/generated: +${add} −${del} lines cut]`)
      continue
    }
    let used = 0
    const kept: string[] = []
    let i = 0
    for (; i < f.lines.length; i += 1) {
      const line = clip(f.lines[i] ?? '', 300)
      if (used + line.length > perFile && kept.length > 4) break
      kept.push(line)
      used += line.length + 1
    }
    if (i < f.lines.length && f.lines.length - i <= 3) {
      for (; i < f.lines.length; i += 1) kept.push(clip(f.lines[i] ?? '', 300))
    }
    if (i < f.lines.length) {
      const rest = counts(f.lines.slice(i))
      kept.push(`  … [${plural(f.lines.length - i, 'more diff line')} in ${f.name} cut: +${rest.add} −${rest.del}] …`)
      cutFiles += 1
    }
    out.push(kept.join('\n'))
  }
  const totals = counts(lines)
  const head = `${plural(files.length, 'file')} changed, +${totals.add} −${totals.del}`
  return {
    text: `${head}\n${out.join('\n')}`,
    kind: 'diff',
    kept: `every file's header and counts${generated.length ? `, ${plural(generated.length, 'lockfile/generated file')} reduced to counts` : ''}${cutFiles ? `, the start of the hunks in ${plural(cutFiles, 'long file')}` : ', every hunk'}`,
  }
}

// ---------- grep results ----------

export const dietGrep = (text: string, target: number): DietOutput => {
  const lines = normalize(text).filter(l => l !== '' && l !== '--')
  const byFile = new Map<string, string[]>()
  const other: string[] = []
  for (const line of lines) {
    const m = /^([^\s:]+?)[:-](\d+)[:-](.*)$/.exec(line)
    if (!m) {
      other.push(line)
      continue
    }
    const file = m[1] ?? ''
    const list = byFile.get(file) ?? []
    list.push(`  ${m[2]}: ${clip((m[3] ?? '').trim(), 200)}`)
    byFile.set(file, list)
  }
  const total = [...byFile.values()].reduce((n, l) => n + l.length, 0)
  for (const sample of [50, 25, 12, 6, 3, 1, 0]) {
    const out = [...other.slice(0, 3), `${plural(total, 'match')} in ${plural(byFile.size, 'file')}`]
    let shown = 0
    let used = out.join('\n').length
    for (const [file, hits] of byFile) {
      const block = [`${file} (${hits.length})`, ...hits.slice(0, sample), ...(hits.length > sample && sample ? [`  … ${hits.length - sample} more`] : [])].join('\n')
      if (used + block.length > target && shown > 0) break
      out.push(block)
      used += block.length + 1
      shown += 1
    }
    if (shown < byFile.size) out.push(`… and ${plural(byFile.size - shown, 'more file')}`)
    if (used <= target || sample === 0) {
      return {
        text: out.join('\n'),
        kind: 'grep',
        kept: `match counts for ${shown === byFile.size ? 'every file' : `${shown} of ${plural(byFile.size, 'file')}`}${sample ? `, the first ${sample} match${sample > 1 ? 'es' : ''} in each` : ''}`,
      }
    }
  }
  return { text: lines.slice(0, 50).join('\n'), kind: 'grep', kept: 'the first matches' }
}

// ---------- tables and data ----------

const DELIMITERS = [',', '\t', '|', ';']
const NUMERIC_ROW = /^[\s\d.,:;|+\-eE%$€/()]+$/

const cellsOf = (line: string, delim: string) => line.split(delim).length - 1

/** CSV/TSV/pipe tables, and rows of numbers: data an agent may need exactly. */
export const isTable = (lines: string[]) => {
  if (lines.filter(l => NUMERIC_ROW.test(l)).length >= lines.length * 0.85) return true
  for (const delim of DELIMITERS) {
    const counts = new Map<number, number>()
    for (const l of lines) counts.set(cellsOf(l, delim), (counts.get(cellsOf(l, delim)) ?? 0) + 1)
    const [cells, rows] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] ?? [0, 0]
    if (cells >= (delim === '|' ? 2 : delim === ',' ? 2 : 1) && rows >= lines.length * 0.85) return true
  }
  return false
}

export const dietTable = (text: string, target: number): DietOutput => {
  const lines = normalize(text).filter(l => l !== '')
  const delim = DELIMITERS.find(d => cellsOf(lines[1] ?? '', d) >= 1 && cellsOf(lines[1] ?? '', d) === cellsOf(lines[2] ?? '', d))
  const first = lines[0] ?? ''
  const hasHeader = delim !== undefined && !NUMERIC_ROW.test(first) && cellsOf(first, delim) === cellsOf(lines[1] ?? '', delim)
  const columns = hasHeader && delim ? first.split(delim).map(c => c.trim()) : []
  const rows = hasHeader ? lines.slice(1) : lines
  const head: string[] = []
  const tail: string[] = []
  let used = first.length + 120
  for (let i = 0; i < rows.length && used < target * 0.55; i += 1) {
    head.push(clip(rows[i] ?? '', 300))
    used += (head.at(-1)?.length ?? 0) + 1
  }
  for (let i = rows.length - 1; i >= head.length && used < target; i -= 1) {
    tail.unshift(clip(rows[i] ?? '', 300))
    used += (tail[0]?.length ?? 0) + 1
  }
  const cut = rows.length - head.length - tail.length
  const offset = hasHeader ? 2 : 1
  const summary = `Table: ${plural(rows.length, 'row')}${columns.length ? ` × ${plural(columns.length, 'column')} (${columns.slice(0, 20).join(', ')}${columns.length > 20 ? ', …' : ''})` : ''}`
  const out = [summary, ...(hasHeader ? [first] : []), ...head]
  if (cut > 0) out.push(`… [${plural(cut, 'row')} cut: output lines ${head.length + offset}–${head.length + offset + cut - 1}; nothing in between is shown or summarized] …`)
  out.push(...tail)
  return {
    text: out.join('\n'),
    kind: 'table',
    kept: `${hasHeader ? 'the header, ' : ''}the first ${head.length} and last ${tail.length} rows exactly; the ${plural(cut, 'row')} between them are not shown`,
  }
}

// ---------- path lists ----------

export const dietPaths = (text: string, target: number): DietOutput => {
  const lines = normalize(text).map(l => l.trim()).filter(l => l !== '')
  const header = lines[0] && !isPathLike(lines[0]) ? [lines[0]] : []
  const paths = lines.filter(l => isPathLike(l))
  const byDir = new Map<string, string[]>()
  for (const p of paths) {
    const slash = p.replace(/\/$/, '').lastIndexOf('/')
    const dir = slash >= 0 ? p.slice(0, slash + 1) : './'
    const list = byDir.get(dir) ?? []
    list.push(slash >= 0 ? p.slice(slash + 1) : p)
    byDir.set(dir, list)
  }
  const dirs = [...byDir.keys()]
  let prefix = dirs[0] ?? ''
  for (const d of dirs) while (prefix && !d.startsWith(prefix)) prefix = prefix.slice(0, prefix.slice(0, -1).lastIndexOf('/') + 1)
  if (prefix.length < 8) prefix = ''
  const show = (dir: string) => (prefix && dir !== prefix ? dir.slice(prefix.length) : dir)
  const all = [...byDir.entries()]
  for (const names of [8, 4, 2, 0]) {
    const out = [...header, `${plural(paths.length, 'path')} in ${plural(byDir.size, 'directory')}${prefix ? `, all under ${prefix}` : ''}`]
    const full = all.map(([dir, list]) => (names ? `${show(dir)} (${list.length}): ${list.slice(0, names).join(', ')}${list.length > names ? `, … +${list.length - names}` : ''}` : `${show(dir)} (${list.length})`))
    const fits = full.reduce((n, l) => n + l.length + 1, out.join('\n').length) <= target
    // when not every directory fits, list the biggest ones
    const order = fits ? all.map((_, i) => i) : all.map((e, i) => [e[1].length, i] as const).sort((a, b) => b[0] - a[0]).map(([, i]) => i)
    let used = out.join('\n').length
    let shown = 0
    for (const i of order) {
      const line = clip(full[i] ?? '', 500)
      if (used + line.length > target && shown > 0) break
      out.push(line)
      used += line.length + 1
      shown += 1
    }
    if (shown < byDir.size) out.push(`… and ${plural(byDir.size - shown, 'more directory')} (${(paths.length - order.slice(0, shown).reduce((n, i) => n + (all[i]?.[1].length ?? 0), 0)).toLocaleString('en-US')} paths)`)
    if (used <= target || names === 0) {
      return { text: out.join('\n'), kind: 'paths', kept: `${shown < byDir.size ? `the ${shown} biggest of ${byDir.size} directories` : 'every directory'} with path counts${names ? ` and the first ${names} names in each` : ''}` }
    }
  }
  return { text: paths.slice(0, 50).join('\n'), kind: 'paths', kept: 'the first paths' }
}

// ---------- entry ----------

export const diet = (input: DietInput): DietOutput => {
  const kind = detectKind(input.text, input.tool, input.command)
  switch (kind) {
    case 'json':
      return dietJson(input.text, input.target)
    case 'diff':
      return dietDiff(input.text, input.target)
    case 'grep':
      return dietGrep(input.text, input.target)
    case 'table':
      return dietTable(input.text, input.target)
    case 'paths':
      return dietPaths(input.text, input.target)
    default:
      return dietLog(input.text, input.target)
  }
}

/** Roughly how many tokens a text costs: about four characters each. */
export const tokensOf = (chars: number) => Math.round(chars / 4)

export const fmtTokens = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
