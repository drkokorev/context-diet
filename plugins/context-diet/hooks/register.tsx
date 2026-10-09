import { atom, read, update } from 'claude-code'
import type { Elements, EngineInterface, Register } from 'claude-code'

import type { DietCut, DietPrefs, DietStats, DietView } from '../types'
import { diet, dietDelta, fmtTokens, tokensOf } from './diet'

// Context Diet: trims huge tool outputs before they reach the model's context.
// The model reads a shortened text with a note on what was cut; the full
// output is saved under .context-diet/ in the project, where Claude can read it.

const PANE = 'context-diet'
const DIR = '.context-diet'
const SLOTS = 300
const LOG_SIZE = 30
const THRESHOLDS = [4_000, 8_000, 16_000, 32_000]
const BIG_CUT_TOKENS = 20_000

const EMPTY_STATS: DietStats = {
  startedAt: 0,
  cuts: 0,
  rawChars: 0,
  keptChars: 0,
  passed: 0,
  upgrades: 0,
  rereads: 0,
  recovered: 0,
  byTool: {},
  log: [],
  lifetimeSaved: 0,
  lifetimeCuts: 0,
}

export const DEFAULT_PREFS: DietPrefs = {
  isOn: true,
  threshold: 8_000,
  isStatusOn: true,
  isToastOn: true,
  isDry: false,
  isCapture: false,
  boost: {},
}

const stats = atom({ plugin: 'context-diet', key: 'stats' } as const, EMPTY_STATS)
const prefs = atom({ plugin: 'context-diet', key: 'prefs' } as const, DEFAULT_PREFS)
const view = atom({ plugin: 'context-diet', key: 'view' } as const, { openCut: 0, isPlaced: false, reason: '' } as DietView)

type Dollar = EngineInterface
type DietElements = Pick<Elements['terminal'] | Elements['desktop'], 'Box' | 'Text' | 'Button'>
type CallInfo = { tool: string; label: string; command?: string; sig?: string; capture?: string }
/** The last full output of a command, to show only what changed when it runs again. */
type Run = { raw: string; at: number }

// tool calls by tool_use_id, so a result can be traced to its command
const calls = new Map<string, CallInfo>()
// the last output of each command this session, by the command's text
const runs = new Map<string, Run>()
// saved full outputs by path, so a later Read of one is counted against its cut
const saved = new Map<string, string>()
// this project's commands whose output stays whole (/diet keep)
let keep: string[] = []
let cwd = ''
let slot = -1
// a Bash command's whole output by tool_use_id, taken before Claude Code shortens it
const fulls = new Map<string, string>()
// folders whose .gitignore is known to be in place
const readyDirs = new Set<string>()

const shorten = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat
}

/** mcp__github__list_issues reads as github·list_issues */
const toolName = (tool: string) => (tool.startsWith('mcp__') ? tool.split('__').slice(1).join('·') : tool)

const fmtChars = (n: number) => (n >= 1000 ? `${fmtTokens(n)}` : String(n))
const plural = (n: number, word: string) => `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`

/** A command's first two words past env assignments and `cd …&&`: "npm test", "cargo build". */
export const sigOf = (tool: string, command?: string) => {
  if (!command) return tool
  const words = command
    .replace(/^(?:\s*cd\s+\S+\s*&&)+/, '')
    .trim()
    .split(/\s+/)
    .filter(w => !/^\w+=/.test(w))
  // past launchers (python -m, npx, uv run…) to the tool itself
  while (words.length > 1 && /^(?:python[\d.]*|py|npx|bunx|pnpm|yarn|uv|poetry|pipenv|bundle|go|cargo|npm)$/.test(words[0] ?? '')) {
    if (/^(?:npx|bunx)$/.test(words[0] ?? '')) words.splice(0, 1)
    else if (/^(?:-m|run|exec|x)$/.test(words[1] ?? '')) words.splice(0, 2)
    else break
  }
  // the tool and its subcommand (npm test, go test, cargo build), never a flag, its value or a path
  const [first, second] = words
  if (!first) return tool
  return second && /^[a-z][a-z0-9_-]*$/.test(second) ? `${first} ${second}` : first
}

/** Which tools' outputs get cut; MCP tools only when they answer JSON. */
const isDietTool = (tool: string) => ['Bash', 'BashOutput', 'TaskOutput', 'Grep', 'Glob'].includes(tool) || tool.startsWith('mcp__')

const labelOf = (tool: string, args: Record<string, unknown>) => {
  if (typeof args.command === 'string') return shorten(args.command, 60)
  if (typeof args.pattern === 'string') return shorten(`${tool} ${args.pattern}${typeof args.path === 'string' ? ` in ${args.path}` : ''}`, 60)
  if (tool.startsWith('mcp__')) return tool.split('__').slice(1).join(' · ')
  return tool
}

/** The text of a tool_result's content, or undefined when it holds images or documents. */
const textOf = (content: unknown): string | undefined => {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return undefined
  const blocks = content as { type?: string; text?: unknown }[]
  if (blocks.some(b => b.type !== 'text' || typeof b.text !== 'string')) return undefined
  return blocks.map(b => b.text as string).join('\n')
}

export const rememberCall = (id: string, info: CallInfo) => {
  calls.set(id, info)
  if (calls.size > 500) calls.delete(calls.keys().next().value as string)
}

const loadSlot = async ($: Dollar) => {
  if (slot < 0) slot = Number((await $.store.get('slot')) ?? 0) || 0
}

const takeSlot = () => {
  slot = (Math.max(0, slot) % SLOTS) + 1
  return String(slot).padStart(3, '0')
}

const ensureDir = async ($: Dollar, root: string) => {
  if (readyDirs.has(root)) return
  const ignore = `${root}/${DIR}/.gitignore`
  if (!(await $.fs.exists(ignore))) {
    await $.fs.write(ignore, '# Context Diet keeps full tool outputs here. Nothing in this folder belongs in git.\n*\n')
  }
  readyDirs.add(root)
}

/** The session's working directory now: it can change during a session, so it is asked each time. */
const rootOf = async ($: Dollar) => {
  cwd = (await $.session.cwd().catch(() => cwd)) || cwd
  return cwd
}

const pushStatus = async ($: Dollar) => {
  const p = await read($, prefs)
  if (!p.isStatusOn) {
    $.ui.status(undefined)
    return
  }
  if (!p.isOn) {
    $.ui.status('◇ diet off')
    return
  }
  const s = await read($, stats)
  if (!s.cuts) {
    $.ui.status(undefined)
    return
  }
  $.ui.status(`◇ diet${p.isDry ? ' dry' : ''} −${fmtTokens(tokensOf(s.rawChars - s.keptChars))} tok · ${plural(s.cuts, 'cut')}${s.rereads ? ` · ${s.rereads} reopened` : ''}`)
}

type Decision = { text: string; cut: DietCut; save: string } | { skip: string }
type Where = {
  root: string
  now: number
  slot: () => string
  agentId?: string
  /** outputs Claude Code already saved to a file, by that file's path: their full text */
  persisted?: Record<string, string>
  /** earlier outputs of the same commands */
  runs?: ReadonlyMap<string, Run>
  /** commands whose output stays whole in this project */
  keep?: readonly string[]
  /** whole Bash outputs by tool_use_id, from before Claude Code shortened them */
  fulls?: ReadonlyMap<string, string>
}

const hhmm = (at: number) => new Date(at).toTimeString().slice(0, 5)

// Claude Code moves a very long output to a file itself and shows only its start
const PERSISTED = /^\s*<persisted-output>[\s\S]*?Full output saved to: (\S+)/

export const persistedPath = (text: string) => PERSISTED.exec(text)?.[1]

/** Cuts one tool result's text if it is long and the cut saves enough. */
const cutOne = (raw: string, info: CallInfo, p: DietPrefs, where: Where, savedAt?: string, shortenedTo?: number): Decision => {
  const sig = info.sig ?? sigOf(info.tool, info.command)
  if (raw.length <= p.threshold * (p.boost?.[sig] ?? 1)) return { skip: 'short' }
  if (info.command && /\.context-diet\/|diet:off/.test(info.command)) return { skip: 'excluded' }
  if (info.command && where.keep?.some(k => info.command?.includes(k))) return { skip: 'kept' }
  // a digest in place of Claude Code's preview stays near the preview's size
  const target = savedAt ? 3_000 : Math.max(2_000, Math.round(p.threshold / 2))
  let out
  try {
    const before = info.command ? where.runs?.get(info.command) : undefined
    const delta = before ? dietDelta(before.raw, raw, target, hhmm(before.at)) : undefined
    const fresh = diet({ text: raw, tool: info.tool, command: info.command, target })
    out = delta && delta.text.length < fresh.text.length ? delta : fresh
  } catch {
    return { skip: 'error' }
  }
  if (info.tool.startsWith('mcp__') && out.kind !== 'json') return { skip: 'prose' }
  if (out.text.length > raw.length * 0.7 || raw.length - out.text.length < 2_000) return { skip: 'small gain' }

  const path = savedAt ?? info.capture ?? (p.isDry ? '(dry run: not saved)' : `${where.root}/${DIR}/out-${where.slot()}.txt`)
  const size = raw.length.toLocaleString('en-US')
  const note = savedAt
    ? `[Context Diet: digest of a ${size}-character ${info.tool} output that Claude Code saved to ${path}. Kept: ${out.kept}. Read that file before answering about anything not shown here.]`
    : shortenedTo !== undefined
    ? `[Context Diet: Claude Code would have shown only ${shortenedTo.toLocaleString('en-US')} characters of this ${size}-character ${info.tool} output, cutting its middle and end; here is a digest of the whole output. Kept: ${out.kept}. Full output: ${path}. Read it before answering about anything not shown here.]`
    : `[Context Diet: ${info.tool} output cut from ${size} to ${out.text.length.toLocaleString('en-US')} characters. Kept: ${out.kept}. Full output: ${path}. Read it before answering about anything not shown here.]`
  const cut: DietCut = {
    at: where.now,
    tool: info.tool,
    label: info.label,
    kind: out.kind,
    // what Claude would otherwise have read: Claude Code's shortened text, when it shortened it
    raw: shortenedTo ?? raw.length,
    kept: out.text.length + note.length,
    path,
    preview: out.text.slice(0, 1200),
    keptWhat: out.kept,
    sig,
    ...(where.agentId ? { agentId: where.agentId } : {}),
    ...(savedAt ? { isUpgrade: true as const } : {}),
    ...(p.isDry ? { isDry: true as const } : {}),
    ...(shortenedTo !== undefined ? { recoveredFrom: shortenedTo } : {}),
  }
  return { text: `${note}\n${out.text}`, cut, save: raw }
}

type Block = { type: string; [field: string]: unknown }
type Save = { path: string; text: string }

/**
 * Cuts the long tool results among a row's blocks; the rest pass as they are.
 * Pure: the caller writes `saves` to disk before the row is stored.
 */
export const dietBlocks = (blocks: readonly Block[], origin: { kind?: string; tool?: string }, p: DietPrefs, where: Where) => {
  const cuts: DietCut[] = []
  const saves: Save[] = []
  const skipped: string[] = []
  const content: Block[] = []
  const seen: { command: string; raw: string }[] = []
  if (!p.isOn) return { content: [...blocks], cuts, saves, skipped, seen }
  for (const block of blocks) {
    if (block.type !== 'tool_result') {
      content.push(block)
      continue
    }
    const id = typeof block.tool_use_id === 'string' ? block.tool_use_id : ''
    const known = calls.get(id)
    const tool = known?.tool ?? (origin.kind === 'tool' && origin.tool ? origin.tool : 'unknown')
    const shown = textOf(block.content)
    const savedAt = shown === undefined ? undefined : persistedPath(shown)
    const whole = where.fulls?.get(id)
    // Claude Code shortened it (a failing command's output is cut to about 10,000 characters): digest the whole one
    const recovered = shown !== undefined && savedAt === undefined && whole !== undefined && whole.length > shown.length + 500 ? whole : undefined
    const raw = recovered ?? (savedAt !== undefined && where.persisted?.[savedAt] !== undefined ? where.persisted[savedAt] : shown)
    if (raw === undefined || !isDietTool(tool)) {
      content.push(block)
      continue
    }
    const decision = cutOne(raw, known ?? { tool, label: tool }, p, where, raw === shown || recovered ? undefined : savedAt, recovered ? shown?.length : undefined)
    if (known?.command && raw.length > p.threshold / 2) seen.push({ command: known.command, raw })
    if ('skip' in decision) {
      if (decision.skip !== 'short') skipped.push(decision.skip)
      content.push(block)
      continue
    }
    calls.delete(id)
    cuts.push(decision.cut)
    // a dry run measures only: the model reads the output as it came
    if (p.isDry) {
      content.push(block)
      continue
    }
    if (!decision.cut.isUpgrade && !decision.cut.path.endsWith('.log')) saves.push({ path: decision.cut.path, text: decision.save })
    content.push({ ...block, content: typeof block.content === 'string' ? decision.text : [{ type: 'text', text: decision.text }] })
  }
  return { content, cuts, saves, skipped, seen }
}

/** The whole stdout and stderr of a Bash call as the tool returned them, before the model's view is shortened. */
export const fullTextOf = (result: unknown): string | undefined => {
  const r = result as { isError?: boolean; result?: unknown; deny?: string } | undefined
  if (!r || r.deny !== undefined) return undefined
  const body = r.result as { stdout?: unknown; stderr?: unknown; persistedOutputPath?: unknown; isImage?: unknown } | string | undefined
  if (typeof body === 'string') return body
  if (!body || body.isImage || typeof body.persistedOutputPath === 'string') return undefined
  const out = typeof body.stdout === 'string' ? body.stdout : ''
  const err = typeof body.stderr === 'string' ? body.stderr : ''
  return out && err ? `${out}\n${err}` : out || err || undefined
}

const keepFull = (id: string, result: unknown) => {
  const full = fullTextOf(result)
  if (!full || full.length > 4_000_000) return
  fulls.set(id, full)
  if (fulls.size > 20) fulls.delete(fulls.keys().next().value as string)
}

// test runners and build tools whose whole output /diet capture saves
const CAPTURABLE =
  /^(?:cd\s+\S+\s*&&\s*)?(?:\w+=\S+\s+)*(?:(?:npx|bunx|pnpm(?:\s+exec)?|yarn|uv\s+run|poetry\s+run|pipenv\s+run|python[\d.]*\s+-m|bundle\s+exec)\s+)?(?:pytest|jest|vitest|mocha|tsc|eslint|ruff|mypy|rspec|phpunit|go\s+(?:test|build|vet)|cargo\s+(?:test|build|check|clippy)|(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|build|lint|typecheck|check)|make(?:\s+[\w-]+)?|gradle|\.\/gradlew|mvn|dotnet\s+(?:test|build))\b/

const shellQuote = (text: string) => `'${text.replace(/'/g, "'\\''")}'`

/**
 * A test or build command rewritten to save its whole output before Claude Code
 * can shorten it: run in the same shell (so a `cd` still sticks), output to the
 * file, then printed, with the command's own exit code. Undefined for anything
 * else: pipes, redirects, background jobs, several commands, watch modes.
 */
export const captureCommand = (command: string, file: string): string | undefined => {
  const plain = command.trim()
  if (!CAPTURABLE.test(plain)) return undefined
  const rest = plain.replace(/^cd\s+\S+\s*&&\s*/, '')
  if (/[|<>;`\n]|\$\(|&|--watch\b|\bwatch\b|diet:off/.test(rest)) return undefined
  return `{ ${plain}\n} > ${shellQuote(file)} 2>&1; __diet_rc=$?; cat ${shellQuote(file)}; (exit $__diet_rc)`
}

let runSlot = 0

const rememberRun = (command: string, raw: string, at: number) => {
  if (raw.length > 2_000_000) return
  runs.delete(command)
  runs.set(command, { raw, at })
  if (runs.size > 20) runs.delete(runs.keys().next().value as string)
}

/**
 * Claude opened a saved full output: the digest was not enough. Counted on the
 * cut, and after two re-reads of one command's outputs (half its cuts or more)
 * that command is cut only when twice as long.
 */
const countReread = async ($: Dollar, path: string) => {
  const sig = saved.get(path) ?? ''
  const s = await update($, stats, cur => ({
    ...cur,
    rereads: (cur.rereads ?? 0) + 1,
    log: cur.log.map(c => (c.path === path ? { ...c, rereads: (c.rereads ?? 0) + 1 } : c)),
  }))
  const ofSig = s.log.filter(c => (c.sig ?? c.tool) === sig)
  const rereads = ofSig.reduce((n, c) => n + (c.rereads ?? 0), 0)
  if (rereads >= 2 && rereads >= ofSig.length / 2) {
    const p = await update($, prefs, cur => ({ ...cur, boost: { ...cur.boost, [sig]: Math.min(8, (cur.boost?.[sig] ?? 1) * 2) } }))
    $.ui.toast(`Context Diet: Claude kept opening the full output of "${sig}", so it is now cut only past ${fmtChars(p.threshold * (p.boost[sig] ?? 1))} characters.`)
    await update($, stats, cur => ({ ...cur, log: cur.log.map(c => ((c.sig ?? c.tool) === sig ? { ...c, rereads: 0 } : c)) }))
  }
  $.ui.invalidate('ui.render')
}

export const recordCut = async ($: Dollar, cut: DietCut) => {
  if (cut.isUpgrade) {
    await update($, stats, cur => ({ ...cur, upgrades: (cur.upgrades ?? 0) + 1, log: [...cur.log, cut].slice(-LOG_SIZE) }))
    await pushStatus($)
    $.ui.invalidate('ui.render')
    return
  }
  const s = await update($, stats, cur => {
    const t = cur.byTool[cut.tool] ?? { cuts: 0, raw: 0, kept: 0 }
    return {
      ...cur,
      cuts: cur.cuts + 1,
      recovered: (cur.recovered ?? 0) + (cut.recoveredFrom !== undefined ? 1 : 0),
      rawChars: cur.rawChars + cut.raw,
      keptChars: cur.keptChars + cut.kept,
      byTool: { ...cur.byTool, [cut.tool]: { cuts: t.cuts + 1, raw: t.raw + cut.raw, kept: t.kept + cut.kept } },
      log: [...cur.log, cut].slice(-LOG_SIZE),
      lifetimeSaved: cur.lifetimeSaved + (cut.isDry ? 0 : cut.raw - cut.kept),
      lifetimeCuts: cur.lifetimeCuts + (cut.isDry ? 0 : 1),
    }
  })
  if (!cut.isDry) void $.store.set('lifetime', { saved: s.lifetimeSaved, cuts: s.lifetimeCuts })
  await pushStatus($)
  $.ui.invalidate('ui.render')
  const p = await read($, prefs)
  const tokens = tokensOf(cut.raw - cut.kept)
  if (p.isToastOn && (s.cuts === 1 || tokens >= BIG_CUT_TOKENS)) {
    $.ui.toast(
      cut.isDry
        ? `Context Diet (dry run) would trim this ${cut.tool} output: ${fmtChars(cut.raw)} → ${fmtChars(cut.kept)} chars, ≈${fmtTokens(tokens)} tokens. Nothing was changed`
        : `Context Diet trimmed ${cut.tool} output: ${fmtChars(cut.raw)} → ${fmtChars(cut.kept)} chars, ≈${fmtTokens(tokens)} tokens saved. /diet for details`,
    )
  }
}

/** Sample cuts for /diet demo, so the panel can be seen before a long session. */
const demoStats = (s: DietStats, now: number, root: string): DietStats => {
  const sample: [string, string, DietCut['kind'], number, number, string, string][] = [
    ['Bash', 'npm test', 'jest', 182_400, 1_310, 'every failure with its message and code frame, the summary', '[jest] 611 passing files not listed, 1 failing\n> acme-web@2.4.0 test\n… [409 lines cut] …\nFAIL src/billing/invoice.test.ts\n  ● invoice › applies VAT for EU customers\n    Expected: 121.5\n    Received: 120\nTests:       1 failed, 4231 passed, 4232 total'],
    ['Bash', 'git diff', 'diff', 96_800, 3_950, "every file's header and counts, 1 lockfile/generated file reduced to counts, every hunk", '3 files changed, +4012 −36\ndiff --git a/src/app.ts b/src/app.ts\n@@ -10,6 +10,7 @@\n-  const b = 2\n+  const b = 3\ndiff --git a/package-lock.json b/package-lock.json\n  [lockfile/generated: +3990 −30 lines cut]'],
    ['Grep', 'Grep useSession in src', 'grep', 41_200, 3_600, 'match counts for every file, the first 3 matches in each', '612 matches in 48 files\nsrc/app/session.ts (41)\n  12: export function useSession() {\n  … 40 more'],
    ['mcp__github__list_issues', 'github · list_issues', 'json', 233_000, 3_980, 'the structure of an array of 300 items: every key, the first items of each array, strings shortened', '[\n {\n  "number": 812,\n  "title": "Crash on start",\n  "body": "Steps…(+2,410 chars)"\n },\n "… 297 more items (keys: number, title, body, labels, user)"\n]'],
    ['Bash', 'find . -name "*.ts"', 'paths', 64_500, 2_870, "every directory's count and its first 8 names", '2,140 paths in 96 directories\nsrc/components/ (88): Button.ts, Card.ts, …'],
  ]
  const log: DietCut[] = sample.map(([tool, label, kind, raw, kept, keptWhat, preview], i) => ({
    at: now - (sample.length - i) * 240_000,
    tool,
    label,
    kind,
    raw,
    kept,
    keptWhat,
    preview,
    path: `${root}/${DIR}/out-00${i + 1}.txt`,
    ...(i === 2 ? { rereads: 1 } : {}),
  }))
  const byTool: DietStats['byTool'] = {}
  for (const c of log) {
    const t = byTool[c.tool] ?? { cuts: 0, raw: 0, kept: 0 }
    byTool[c.tool] = { cuts: t.cuts + 1, raw: t.raw + c.raw, kept: t.kept + c.kept }
  }
  const raw = log.reduce((n, c) => n + c.raw, 0)
  const kept = log.reduce((n, c) => n + c.kept, 0)
  return { ...s, cuts: log.length, rawChars: raw, keptChars: kept, byTool, log, rereads: 1, lifetimeSaved: Math.max(s.lifetimeSaved, (raw - kept) * 14), lifetimeCuts: Math.max(s.lifetimeCuts, 73) }
}

const buildReport = (s: DietStats, p: DietPrefs) => {
  const saved = s.rawChars - s.keptChars
  const lines = [
    `Context Diet is ${p.isOn ? (p.isDry ? 'in a dry run (nothing is changed; figures show what would be saved)' : 'on') : 'off'}${p.isOn && p.isCapture ? ', with capture' : ''}: cuts Bash, Grep, Glob and MCP JSON outputs over ${p.threshold.toLocaleString('en-US')} characters (≈${fmtTokens(tokensOf(p.threshold))} tokens).`,
    s.cuts
      ? `This session: ${plural(s.cuts, 'cut')}, ${fmtChars(s.rawChars)} → ${fmtChars(s.keptChars)} characters, ≈${fmtTokens(tokensOf(saved))} tokens saved (−${Math.round((saved / Math.max(1, s.rawChars)) * 100)}%).`
      : 'This session: nothing cut yet.',
    `All time: ${plural(s.lifetimeCuts, 'cut')}, ≈${fmtTokens(tokensOf(s.lifetimeSaved))} tokens saved.`,
  ]
  if (s.upgrades) lines.push(`Very long outputs Claude Code saved to a file: ${s.upgrades}, each shown as a digest of the whole output instead of its first lines.`)
  if (s.recovered) lines.push(`Outputs Claude Code would have cut in the middle and end (failing commands): ${s.recovered}, each digested whole, so the failures at the end were kept.`)
  const cutCount = s.cuts + (s.upgrades ?? 0)
  if (cutCount) lines.push(`Claude opened a saved full output ${plural(s.rereads ?? 0, 'time')} after ${plural(cutCount, 'cut')}${s.rereads ? ': where that happens often, the command is cut less.' : '.'}`)
  const boosted = Object.entries(p.boost ?? {})
  if (boosted.length) lines.push(`Cut less because Claude kept opening their full output: ${boosted.map(([sig, x]) => `"${sig}" (past ${fmtChars(p.threshold * x)} chars)`).join(', ')}.`)
  const tools = Object.entries(s.byTool).sort((a, b) => b[1].raw - b[1].kept - (a[1].raw - a[1].kept))
  if (tools.length) {
    lines.push('', 'By tool:')
    for (const [tool, t] of tools) lines.push(`  ${toolName(tool).padEnd(20)} ${plural(t.cuts, 'cut').padEnd(8)} ≈${fmtTokens(tokensOf(t.raw - t.kept))} tokens saved`)
  }
  if (s.log.length) {
    lines.push('', 'Latest cuts (full output in the file):')
    for (const c of [...s.log].reverse().slice(0, 10)) {
      lines.push(`  ${new Date(c.at).toTimeString().slice(0, 5)}  ${c.tool}  ${c.label}  ${c.isUpgrade ? `digest of ${fmtChars(c.raw)}` : `${fmtChars(c.raw)} → ${fmtChars(c.kept)}`}${c.kind === 'delta' ? ' (changes only)' : ''}${c.recoveredFrom !== undefined ? ' (whole output, not Claude Code\'s shortened one)' : ''}${c.rereads ? `  reopened ×${c.rereads}` : ''}  ${c.path}`)
    }
  }
  return lines.join('\n')
}

const openPane = async ($: Dollar) => {
  const opened = await $.ui.open({ id: PANE, title: 'Context Diet', rows: 22 })
  await update($, view, cur => ({ ...cur, isPlaced: opened.isPlaced, reason: opened.isPlaced ? '' : opened.reason }))
  return opened
}

const setThreshold = async ($: Dollar, threshold: number) => {
  await update($, prefs, p => ({ ...p, threshold }))
  $.ui.invalidate('ui.render')
}

const toggleOn = async ($: Dollar) => {
  await update($, prefs, p => ({ ...p, isOn: !p.isOn }))
  await pushStatus($)
  $.ui.invalidate('ui.render')
}

const toggleDry = async ($: Dollar) => {
  await update($, prefs, p => ({ ...p, isOn: true, isDry: !p.isDry }))
  await pushStatus($)
  $.ui.invalidate('ui.render')
}

const toggleCut = async ($: Dollar, at: number) => {
  await update($, view, v => ({ ...v, openCut: v.openCut === at ? 0 : at }))
  $.ui.invalidate('ui.render')
}

const drawDiet = async ($: Dollar, els: DietElements, columns: number) => {
  const { Box, Text, Button } = els
  const s = await read($, stats)
  const p = await read($, prefs)
  const v = await read($, view)
  const saved = s.rawChars - s.keptChars
  const pct = Math.round((saved / Math.max(1, s.rawChars)) * 100)
  const width = Math.max(30, columns)
  const tools = Object.entries(s.byTool).sort((a, b) => b[1].raw - b[1].kept - (a[1].raw - a[1].kept))
  const recent = [...s.log].reverse().slice(0, 8)
  const nextThreshold = THRESHOLDS[(THRESHOLDS.indexOf(p.threshold) + 1) % THRESHOLDS.length] ?? 8_000

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" gap={1} flexWrap="wrap">
        <Text bold color="green">◇ CONTEXT DIET</Text>
        <Text color={p.isOn && !p.isDry ? 'green' : 'yellow'}>{p.isOn ? (p.isDry ? 'dry run: measuring only' : 'on') : 'off'}</Text>
        <Text dimColor>{`cuts outputs over ≈${fmtTokens(tokensOf(p.threshold))} tokens`}</Text>
      </Box>
      <Box flexDirection="row" gap={1} marginTop={1} flexWrap="wrap">
        <Text dimColor>{p.isDry ? 'would save' : 'saved'}</Text>
        <Text bold color="green">{`≈${fmtTokens(tokensOf(saved))} tokens`}</Text>
        <Text dimColor>{s.cuts ? `${plural(s.cuts, 'cut')} · ${fmtChars(s.rawChars)} → ${fmtChars(s.keptChars)} chars (−${pct}%)` : 'nothing cut yet'}</Text>
      </Box>
      <Box flexDirection="row" gap={1}>
        <Text dimColor>all-time</Text>
        <Text>{`≈${fmtTokens(tokensOf(s.lifetimeSaved))} tokens · ${plural(s.lifetimeCuts, 'cut')}`}</Text>
      </Box>
      {s.cuts + (s.upgrades ?? 0) ? (
        <Box flexDirection="row" gap={1}>
          <Text dimColor>reopened</Text>
          <Text color={(s.rereads ?? 0) > (s.cuts + (s.upgrades ?? 0)) / 3 ? 'yellow' : undefined}>{`${plural(s.rereads ?? 0, 'time')} Claude opened a full output after a cut`}</Text>
        </Box>
      ) : null}
      {s.upgrades ? (
        <Box flexDirection="row" gap={1}>
          <Text dimColor>digests</Text>
          <Text>{`${s.upgrades} very long output${s.upgrades > 1 ? 's' : ''} shown whole-file, not just the start`}</Text>
        </Box>
      ) : null}
      {tools.length ? (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>BY TOOL</Text>
          {tools.map(([tool, t]) => (
            <Box key={`tool-${tool}`} flexDirection="row" gap={1}>
              <Text>{toolName(tool).slice(0, 20).padEnd(20)}</Text>
              <Text dimColor>{plural(t.cuts, 'cut').padEnd(8)}</Text>
              <Text color="green">{`≈${fmtTokens(tokensOf(t.raw - t.kept))} tok`}</Text>
            </Box>
          ))}
        </Box>
      ) : null}
      <Box flexDirection="column" marginTop={1}>
        <Text bold>LATEST CUTS</Text>
        {recent.length === 0 ? (
          <Text dimColor>{`Outputs from Bash, Grep, Glob and MCP tools longer than ${p.threshold.toLocaleString('en-US')} characters are trimmed here; the full text goes to ${DIR}/.`}</Text>
        ) : (
          recent.map(c => {
            const isOpen = v.openCut === c.at
            const head = `${isOpen ? '▾' : '▸'} ${new Date(c.at).toTimeString().slice(0, 5)} ${toolName(c.tool)} ${c.isUpgrade ? `digest ${fmtChars(c.raw)}` : `${fmtChars(c.raw)}→${fmtChars(c.kept)}`}${c.kind === 'delta' ? ' Δ' : ''}${c.rereads ? ` ↻${c.rereads}` : ''}`
            const label = shorten(c.label, Math.max(10, width - head.length - 3))
            return (
              <Box key={`cut-${c.at}`} flexDirection="column">
                <Button key={`cut-${c.at}`} plain label={`${head}  ${label}`} onPress={() => toggleCut($, c.at)} />
                {isOpen ? (
                  <Box flexDirection="column" paddingLeft={2}>
                    <Text dimColor>{`${c.kind} · kept ${c.keptWhat}${c.agentId ? ' · from a subagent' : ''}`}</Text>
                    <Text color="cyan">{c.path}</Text>
                    {c.preview
                      .split('\n')
                      .slice(0, 8)
                      .map((line, i) => (
                        <Text key={`pv-${c.at}-${i}`} dimColor>{shorten(line, width - 4) || ' '}</Text>
                      ))}
                  </Box>
                ) : null}
              </Box>
            )
          })
        )}
      </Box>
      <Box flexDirection="row" gap={1} marginTop={1} flexWrap="wrap">
        <Button key="toggle" variant={p.isOn ? undefined : 'primary'} label={p.isOn ? 'Turn off' : 'Turn on'} onPress={() => toggleOn($)} />
        <Button key="threshold" label={`Cut over: ≈${fmtTokens(tokensOf(p.threshold))} tok`} onPress={() => setThreshold($, nextThreshold)} />
        <Button key="dry" label={p.isDry ? 'Dry run: on' : 'Dry run: off'} onPress={() => toggleDry($)} />
      </Box>
    </Box>
  )
}

const THRESHOLD_ARG = /^(?:threshold\s+)?(\d+(?:\.\d+)?)\s*(k)?$/i

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    cwd = e.cwd
    keep = ((await $.store.get(`keep:${e.cwd}`)) ?? []) as string[]
    await $.command.register({ name: 'diet', description: 'Context Diet: show what was trimmed, or turn it on/off', argumentHint: '[on|off|dry|capture|keep <text>|report|<chars>]' })
    await update($, prefs, p => ({ ...DEFAULT_PREFS, ...p }))
    await update($, stats, cur => ({ ...EMPTY_STATS, ...cur }))
    const current = await read($, stats)
    if (current.startedAt === 0) {
      const lifetime = ((await $.store.get('lifetime')) ?? {}) as { saved?: number; cuts?: number }
      const now = await $.clock.now()
      await update($, stats, s => ({ ...EMPTY_STATS, ...s, startedAt: now, lifetimeSaved: lifetime.saved ?? 0, lifetimeCuts: lifetime.cuts ?? 0 }))
    }
    await pushStatus($)
    return started
  })

  on('tool.call', async ($, e, next) => {
    const args = e as unknown as Record<string, unknown>
    const id = typeof args.tool_use_id === 'string' ? args.tool_use_id : undefined
    const command = typeof args.command === 'string' ? args.command : undefined
    const p = await read($, prefs)
    let capture: string | undefined
    let wrapped: string | undefined
    if (id && e.tool === 'Bash' && command && p.isOn && !p.isDry && p.isCapture && args.run_in_background !== true) {
      const root = await rootOf($)
      runSlot = (runSlot % 20) + 1
      capture = `${root}/${DIR}/run-${String(runSlot).padStart(2, '0')}.log`
      wrapped = captureCommand(command, capture)
      if (wrapped) await ensureDir($, root).catch(() => (wrapped = undefined))
      if (!wrapped) capture = undefined
    }
    if (id && isDietTool(e.tool)) rememberCall(id, { tool: e.tool, label: labelOf(e.tool, args), command, sig: sigOf(e.tool, command), ...(capture ? { capture } : {}) })
    const target = [args.file_path, args.path, command].filter((v): v is string => typeof v === 'string').join(' ')
    const opened = [...saved.keys()].find(path => target.includes(path))
    if (opened) await countReread($, opened)
    const result = await next(wrapped ? ({ ...e, command: wrapped } as typeof e) : e)
    if (id && e.tool === 'Bash') keepFull(id, result)
    return result
  })

  on('session.append', { door: 'tool-result' }, async ($, e, next) => {
    const p = await read($, prefs)
    if (!p.isOn) return next(e)
    const root = await rootOf($)
    await loadSlot($)
    const persisted: Record<string, string> = {}
    for (const block of e.message.content) {
      const shown = block.type === 'tool_result' ? textOf(block.content) : undefined
      const path = shown === undefined ? undefined : persistedPath(shown)
      if (path) persisted[path] = await $.fs.read(path).catch(() => undefined) ?? ''
    }
    for (const [path, text] of Object.entries(persisted)) if (!text) delete persisted[path]
    const now = await $.clock.now()
    const whole = new Map(fulls)
    for (const block of e.message.content) {
      const info = block.type === 'tool_result' ? calls.get(String(block.tool_use_id)) : undefined
      if (info?.capture) {
        const text = await $.fs.read(info.capture).catch(() => undefined)
        if (text) whole.set(String(block.tool_use_id), text)
      }
    }
    const where = { root, now, slot: takeSlot, persisted, runs, keep, fulls: whole, ...(e.agentId ? { agentId: e.agentId } : {}) }
    const { content, cuts, saves, skipped, seen } = dietBlocks(e.message.content, e.origin as { kind?: string; tool?: string }, p, where)
    for (const run of seen) rememberRun(run.command, run.raw, now)
    if (skipped.length) await update($, stats, s => ({ ...s, passed: s.passed + skipped.length }))
    if (!cuts.length) return next(e)
    if (p.isDry) {
      const stored = await next(e)
      for (const cut of cuts) await recordCut($, cut)
      return stored
    }
    try {
      if (saves.length) await ensureDir($, root)
      for (const save of saves) await $.fs.write(save.path, save.text)
    } catch (error) {
      // without the saved file the digest would point nowhere: Claude reads the output whole
      readyDirs.delete(root)
      await $.store.set('lastError', `${new Date(now).toISOString()} could not save the full output under ${root}/${DIR}: ${String(error)}`).catch(() => undefined)
      return next(e)
    }
    void $.store.set('slot', slot)
    for (const cut of cuts) saved.set(cut.path, cut.sig ?? cut.tool)
    const stored = await next({ ...e, message: { ...e.message, content } })
    for (const cut of cuts) await recordCut($, cut)
    return stored
  }).catch(async ($, e, next) => {
    // the output reaches Claude whole; the reason is kept for /diet report
    const error = next.error as { message?: string } | undefined
    await $.store.set('lastError', `${new Date(await $.clock.now()).toISOString()} ${error?.message ?? String(next.error)}`).catch(() => undefined)
    return next(e)
  })

  on('command.run', { command: 'diet' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'on' || arg === 'off') {
      await update($, prefs, p => ({ ...p, isOn: arg === 'on', isDry: false }))
      await pushStatus($)
      $.ui.invalidate('ui.render')
      return { text: `Context Diet is ${arg}.` }
    }
    const m = THRESHOLD_ARG.exec(arg)
    if (m) {
      const chars = Math.round(Number(m[1]) * (m[2] ? 1000 : 1))
      if (chars < 1000) return { text: 'Context Diet: the threshold is in characters and must be at least 1000 (for example /diet 8000 or /diet 8k).' }
      await setThreshold($, chars)
      return { text: `Context Diet now cuts outputs over ${chars.toLocaleString('en-US')} characters (≈${fmtTokens(tokensOf(chars))} tokens).` }
    }
    if (arg === 'dry' || arg === 'dry on' || arg === 'dry off') {
      const p = await update($, prefs, cur => ({ ...cur, isOn: true, isDry: arg === 'dry' ? !cur.isDry : arg === 'dry on' }))
      await pushStatus($)
      $.ui.invalidate('ui.render')
      return { text: p.isDry ? 'Context Diet dry run: outputs reach Claude whole; /diet shows what would have been cut and saved. /diet dry off to cut for real.' : 'Context Diet dry run is off: long outputs are cut again.' }
    }
    if (arg === 'capture' || arg === 'capture on' || arg === 'capture off') {
      const p = await update($, prefs, cur => ({ ...cur, isCapture: arg === 'capture' ? !cur.isCapture : arg === 'capture on' }))
      return {
        text: p.isCapture
          ? 'Context Diet capture is on: test and build commands (pytest, jest, go test, cargo, tsc, npm test…) save their whole output to .context-diet/run-NN.log before Claude Code can shorten it, so the failures at the end of a long failing run are kept. The command Claude Code runs becomes `{ <command>\n} > <file> 2>&1; …`, so a permission rule like Bash(pytest:*) may no longer match it and you may be asked. /diet capture off to stop.'
          : 'Context Diet capture is off: commands run exactly as Claude writes them.',
      }
    }
    const keepArg = /^(keep|unkeep)(?:\s+(.+))?$/i.exec(e.args.trim())
    if (keepArg) {
      const root = await rootOf($)
      const text = keepArg[2]?.trim()
      if (text) {
        keep = keepArg[1]?.toLowerCase() === 'keep' ? [...new Set([...keep, text])] : keep.filter(k => k !== text)
        await $.store.set(`keep:${root}`, keep)
      }
      return { text: keep.length ? `Context Diet keeps whole, in ${root}, the output of any command containing:\n${keep.map(k => `  ${k}`).join('\n')}\n(/diet unkeep <text> removes one)` : `Context Diet: nothing is kept whole in ${root}. /diet keep <text> keeps the output of any command containing that text.` }
    }
    if (arg === 'demo') {
      const now = await $.clock.now()
      await update($, stats, s => ({ ...demoStats(s, now, cwd || '/your/project') }))
      $.ui.invalidate('ui.render')
      await pushStatus($)
      return { text: 'Context Diet: the panel shows sample cuts now. /diet reset clears them.' }
    }
    if (arg === 'reset') {
      await update($, stats, s => ({ ...EMPTY_STATS, startedAt: s.startedAt, lifetimeSaved: s.lifetimeSaved, lifetimeCuts: s.lifetimeCuts }))
      await update($, view, v => ({ ...v, openCut: 0 }))
      $.ui.invalidate('ui.render')
      await pushStatus($)
      return { text: 'Context Diet: this session\'s figures are cleared.' }
    }
    const s = await read($, stats)
    const p = await read($, prefs)
    if (arg === 'report') {
      const lastError = (await $.store.get('lastError')) as string | undefined
      return { text: `${buildReport(s, p)}${lastError ? `\n\nLast error (that output reached Claude whole): ${lastError}` : ''}` }
    }
    if (arg) return { text: 'Usage: /diet [on|off|dry|capture [on|off]|keep <text>|unkeep <text>|report|demo|reset|<chars>], for example /diet 16k' }
    const opened = await openPane($)
    if (opened.isPlaced) return { text: 'Context Diet panel opened.' }
    return { text: `${buildReport(s, p)}\n\n(The side panel is not available here: ${opened.reason}.)` }
  }).catch(($, e, next) => ({ text: `Context Diet: /diet failed: ${String(next.error)}` }))

  on('ui.close', { id: PANE }, async ($, e, next) => {
    const closed = await next(e)
    await update($, view, v => ({ ...v, isPlaced: false }))
    return closed
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => drawDiet($, $.ui.resolve(e), e.props.bodyColumns))
}
