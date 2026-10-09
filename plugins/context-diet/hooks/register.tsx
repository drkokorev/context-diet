import { atom, read, update } from 'claude-code'
import type { Elements, EngineInterface, Register } from 'claude-code'

import type { DietCut, DietPrefs, DietStats, DietView } from '../types'
import { diet, fmtTokens, tokensOf } from './diet'

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
}

const stats = atom({ plugin: 'context-diet', key: 'stats' } as const, EMPTY_STATS)
const prefs = atom({ plugin: 'context-diet', key: 'prefs' } as const, DEFAULT_PREFS)
const view = atom({ plugin: 'context-diet', key: 'view' } as const, { openCut: 0, isPlaced: false, reason: '' } as DietView)

type Dollar = EngineInterface
type DietElements = Pick<Elements['terminal'] | Elements['desktop'], 'Box' | 'Text' | 'Button'>
type CallInfo = { tool: string; label: string; command?: string }

// tool calls by tool_use_id, so a result can be traced to its command
const calls = new Map<string, CallInfo>()
let cwd = ''
let slot = -1
let isDirReady = false

const shorten = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat
}

/** mcp__github__list_issues reads as github·list_issues */
const toolName = (tool: string) => (tool.startsWith('mcp__') ? tool.split('__').slice(1).join('·') : tool)

const fmtChars = (n: number) => (n >= 1000 ? `${fmtTokens(n)}` : String(n))
const plural = (n: number, word: string) => `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`

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
  if (isDirReady) return
  const ignore = `${root}/${DIR}/.gitignore`
  if (!(await $.fs.exists(ignore))) {
    await $.fs.write(ignore, '# Context Diet keeps full tool outputs here. Nothing in this folder belongs in git.\n*\n')
  }
  isDirReady = true
}

const rootOf = async ($: Dollar) => {
  if (!cwd) cwd = await $.session.cwd()
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
  $.ui.status(`◇ diet −${fmtTokens(tokensOf(s.rawChars - s.keptChars))} tok · ${plural(s.cuts, 'cut')}`)
}

type Decision = { text: string; cut: DietCut; save: string } | { skip: string }
type Where = {
  root: string
  now: number
  slot: () => string
  agentId?: string
  /** outputs Claude Code already saved to a file, by that file's path: their full text */
  persisted?: Record<string, string>
}

// Claude Code moves a very long output to a file itself and shows only its start
const PERSISTED = /^\s*<persisted-output>[\s\S]*?Full output saved to: (\S+)/

export const persistedPath = (text: string) => PERSISTED.exec(text)?.[1]

/** Cuts one tool result's text if it is long and the cut saves enough. */
const cutOne = (raw: string, info: CallInfo, p: DietPrefs, where: Where, savedAt?: string): Decision => {
  if (raw.length <= p.threshold) return { skip: 'short' }
  if (info.command && /\.context-diet\/|diet:off/.test(info.command)) return { skip: 'excluded' }
  // a digest in place of Claude Code's preview stays near the preview's size
  const target = savedAt ? 3_000 : Math.max(2_000, Math.round(p.threshold / 2))
  let out
  try {
    out = diet({ text: raw, tool: info.tool, command: info.command, target })
  } catch {
    return { skip: 'error' }
  }
  if (info.tool.startsWith('mcp__') && out.kind !== 'json') return { skip: 'prose' }
  if (out.text.length > raw.length * 0.7 || raw.length - out.text.length < 2_000) return { skip: 'small gain' }

  const path = savedAt ?? `${where.root}/${DIR}/out-${where.slot()}.txt`
  const note = savedAt
    ? `[Context Diet: this ${info.tool} output was ${raw.length.toLocaleString('en-US')} characters (≈${fmtTokens(tokensOf(raw.length))} tokens), too long to show, so Claude Code saved it to ${path}. ` +
      `In place of only its first lines, here is a digest of the whole output. Kept: ${out.kept}. Read the file with offset/limit, or grep it, for anything else. If your answer depends on what is not shown here, read the file first instead of guessing.]`
    : `[Context Diet: this ${info.tool} output was ${raw.length.toLocaleString('en-US')} characters (≈${fmtTokens(tokensOf(raw.length))} tokens), ` +
    `cut to ${out.text.length.toLocaleString('en-US')}. Kept: ${out.kept}. ` +
    `The full output is saved at ${path} (line 1 is a header). Read it with offset/limit, or grep it, if you need anything that was cut. If your answer depends on what is not shown here, read the file first instead of guessing.]`
  const cut: DietCut = {
    at: where.now,
    tool: info.tool,
    label: info.label,
    kind: out.kind,
    raw: raw.length,
    kept: out.text.length + note.length,
    path,
    preview: out.text.slice(0, 1200),
    keptWhat: out.kept,
    ...(where.agentId ? { agentId: where.agentId } : {}),
    ...(savedAt ? { isUpgrade: true as const } : {}),
  }
  return { text: `${note}\n${out.text}`, cut, save: `# Context Diet · ${info.tool} · ${info.label} · ${new Date(where.now).toISOString()}\n${raw}` }
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
  if (!p.isOn) return { content: [...blocks], cuts, saves, skipped }
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
    const raw = savedAt !== undefined && where.persisted?.[savedAt] !== undefined ? where.persisted[savedAt] : shown
    if (raw === undefined || !isDietTool(tool)) {
      content.push(block)
      continue
    }
    const decision = cutOne(raw, known ?? { tool, label: tool }, p, where, raw === shown ? undefined : savedAt)
    if ('skip' in decision) {
      if (decision.skip !== 'short') skipped.push(decision.skip)
      content.push(block)
      continue
    }
    calls.delete(id)
    cuts.push(decision.cut)
    if (!decision.cut.isUpgrade) saves.push({ path: decision.cut.path, text: decision.save })
    content.push({ ...block, content: typeof block.content === 'string' ? decision.text : [{ type: 'text', text: decision.text }] })
  }
  return { content, cuts, saves, skipped }
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
      rawChars: cur.rawChars + cut.raw,
      keptChars: cur.keptChars + cut.kept,
      byTool: { ...cur.byTool, [cut.tool]: { cuts: t.cuts + 1, raw: t.raw + cut.raw, kept: t.kept + cut.kept } },
      log: [...cur.log, cut].slice(-LOG_SIZE),
      lifetimeSaved: cur.lifetimeSaved + (cut.raw - cut.kept),
      lifetimeCuts: cur.lifetimeCuts + 1,
    }
  })
  void $.store.set('lifetime', { saved: s.lifetimeSaved, cuts: s.lifetimeCuts })
  await pushStatus($)
  $.ui.invalidate('ui.render')
  const p = await read($, prefs)
  const saved = tokensOf(cut.raw - cut.kept)
  if (p.isToastOn && (s.cuts === 1 || saved >= BIG_CUT_TOKENS)) {
    $.ui.toast(`Context Diet trimmed ${cut.tool} output: ${fmtChars(cut.raw)} → ${fmtChars(cut.kept)} chars, ≈${fmtTokens(saved)} tokens saved. /diet for details`)
  }
}

/** Sample cuts for /diet demo, so the panel can be seen before a long session. */
const demoStats = (s: DietStats, now: number, root: string): DietStats => {
  const sample: [string, string, DietCut['kind'], number, number, string, string][] = [
    ['Bash', 'npm test', 'log', 182_400, 4_310, 'the first and last lines, 9 of 9 error lines with context, 5 of 5 distinct warnings; repeats folded', '> jest\nPASS src/unit/case0.test.ts (12 ms)\n  … 3,996 similar lines …\nFAIL src/api/user.test.ts\n  ● user › rejects a bad email\n    expect(received).toBe(expected)\nTests: 1 failed, 4000 passed, 4001 total'],
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
  }))
  const byTool: DietStats['byTool'] = {}
  for (const c of log) {
    const t = byTool[c.tool] ?? { cuts: 0, raw: 0, kept: 0 }
    byTool[c.tool] = { cuts: t.cuts + 1, raw: t.raw + c.raw, kept: t.kept + c.kept }
  }
  const raw = log.reduce((n, c) => n + c.raw, 0)
  const kept = log.reduce((n, c) => n + c.kept, 0)
  return { ...s, cuts: log.length, rawChars: raw, keptChars: kept, byTool, log, lifetimeSaved: Math.max(s.lifetimeSaved, (raw - kept) * 14), lifetimeCuts: Math.max(s.lifetimeCuts, 73) }
}

const buildReport = (s: DietStats, p: DietPrefs) => {
  const saved = s.rawChars - s.keptChars
  const lines = [
    `Context Diet is ${p.isOn ? 'on' : 'off'}: cuts Bash, Grep, Glob and MCP JSON outputs over ${p.threshold.toLocaleString('en-US')} characters (≈${fmtTokens(tokensOf(p.threshold))} tokens).`,
    s.cuts
      ? `This session: ${plural(s.cuts, 'cut')}, ${fmtChars(s.rawChars)} → ${fmtChars(s.keptChars)} characters, ≈${fmtTokens(tokensOf(saved))} tokens saved (−${Math.round((saved / Math.max(1, s.rawChars)) * 100)}%).`
      : 'This session: nothing cut yet.',
    `All time: ${plural(s.lifetimeCuts, 'cut')}, ≈${fmtTokens(tokensOf(s.lifetimeSaved))} tokens saved.`,
  ]
  if (s.upgrades) lines.push(`Very long outputs Claude Code saved to a file: ${s.upgrades}, each shown as a digest of the whole output instead of its first lines.`)
  const tools = Object.entries(s.byTool).sort((a, b) => b[1].raw - b[1].kept - (a[1].raw - a[1].kept))
  if (tools.length) {
    lines.push('', 'By tool:')
    for (const [tool, t] of tools) lines.push(`  ${toolName(tool).padEnd(20)} ${plural(t.cuts, 'cut').padEnd(8)} ≈${fmtTokens(tokensOf(t.raw - t.kept))} tokens saved`)
  }
  if (s.log.length) {
    lines.push('', 'Latest cuts (full output in the file):')
    for (const c of [...s.log].reverse().slice(0, 10)) {
      lines.push(`  ${new Date(c.at).toTimeString().slice(0, 5)}  ${c.tool}  ${c.label}  ${c.isUpgrade ? `digest of ${fmtChars(c.raw)}` : `${fmtChars(c.raw)} → ${fmtChars(c.kept)}`}  ${c.path}`)
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
        <Text color={p.isOn ? 'green' : 'yellow'}>{p.isOn ? 'on' : 'off'}</Text>
        <Text dimColor>{`cuts outputs over ≈${fmtTokens(tokensOf(p.threshold))} tokens`}</Text>
      </Box>
      <Box flexDirection="row" gap={1} marginTop={1} flexWrap="wrap">
        <Text dimColor>saved</Text>
        <Text bold color="green">{`≈${fmtTokens(tokensOf(saved))} tokens`}</Text>
        <Text dimColor>{s.cuts ? `${plural(s.cuts, 'cut')} · ${fmtChars(s.rawChars)} → ${fmtChars(s.keptChars)} chars (−${pct}%)` : 'nothing cut yet'}</Text>
      </Box>
      <Box flexDirection="row" gap={1}>
        <Text dimColor>all-time</Text>
        <Text>{`≈${fmtTokens(tokensOf(s.lifetimeSaved))} tokens · ${plural(s.lifetimeCuts, 'cut')}`}</Text>
      </Box>
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
            const head = `${isOpen ? '▾' : '▸'} ${new Date(c.at).toTimeString().slice(0, 5)} ${toolName(c.tool)} ${c.isUpgrade ? `digest ${fmtChars(c.raw)}` : `${fmtChars(c.raw)}→${fmtChars(c.kept)}`}`
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
      </Box>
    </Box>
  )
}

const THRESHOLD_ARG = /^(?:threshold\s+)?(\d+(?:\.\d+)?)\s*(k)?$/i

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    cwd = e.cwd
    isDirReady = false
    await $.command.register({ name: 'diet', description: 'Context Diet: show what was trimmed, or turn it on/off', argumentHint: '[on|off|report|demo|reset|<chars>]' })
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
    if (id && isDietTool(e.tool)) rememberCall(id, { tool: e.tool, label: labelOf(e.tool, args), command: typeof args.command === 'string' ? args.command : undefined })
    return next(e)
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
    const where = { root, now: await $.clock.now(), slot: takeSlot, persisted, ...(e.agentId ? { agentId: e.agentId } : {}) }
    const { content, cuts, saves, skipped } = dietBlocks(e.message.content, e.origin as { kind?: string; tool?: string }, p, where)
    if (skipped.length) await update($, stats, s => ({ ...s, passed: s.passed + skipped.length }))
    if (!cuts.length) return next(e)
    if (saves.length) await ensureDir($, root)
    for (const save of saves) await $.fs.write(save.path, save.text)
    void $.store.set('slot', slot)
    const stored = await next({ ...e, message: { ...e.message, content } })
    for (const cut of cuts) await recordCut($, cut)
    return stored
  })

  on('command.run', { command: 'diet' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'on' || arg === 'off') {
      await update($, prefs, p => ({ ...p, isOn: arg === 'on' }))
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
    if (arg === 'report') return { text: buildReport(s, p) }
    if (arg) return { text: 'Usage: /diet [on|off|report|demo|reset|<chars>], for example /diet 16k' }
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
