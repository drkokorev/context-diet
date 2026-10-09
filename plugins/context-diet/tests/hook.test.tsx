import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { DEFAULT_PREFS, dietBlocks, persistedPath, rememberCall } from '../hooks/register'

const PANE = {
  plugin: 'context-diet',
  component: 'Pane',
  requestId: 'context-diet',
  props: {
    title: 'Context Diet',
    isFocused: true,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const bigLog = () =>
  [
    '> jest',
    Array.from({ length: 4000 }, (_, i) => `PASS src/unit/case${i}.test.ts (${i % 90} ms)`).join('\n'),
    'FAIL src/api/user.test.ts',
    '  ● user › rejects a bad email',
    '    expect(received).toBe(expected)',
    'Tests: 1 failed, 4000 passed, 4001 total',
  ].join('\n')

const setup = (on: On) => {
  mock.clock(on, { now: 1_800_000_000_000 })
  mock.store(on)
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
}

// The test kit has no session core to store rows, so these call the code the
// session.append hook runs, with the row's blocks as the engine hands them.
let slot = 0
const where = { root: '/repo', now: 1_800_000_000_000, slot: () => String(++slot).padStart(3, '0') }

const cutRow = (text: string, tool = 'Bash', id = 'toolu_1', prefs = DEFAULT_PREFS) =>
  dietBlocks([{ type: 'tool_result', tool_use_id: id, content: text }], { kind: 'tool', tool }, prefs, where)

const append = (text: string, tool = 'Bash', id = 'toolu_1', prefs = DEFAULT_PREFS) =>
  (cutRow(text, tool, id, prefs).content[0] as unknown as { content: string }).content

test('a huge Bash output is cut before it is stored, and saved whole', async () => {
  const raw = bigLog()
  const row = cutRow(raw)
  const text = (row.content[0] as unknown as { content: string }).content
  expect(text).toContain('[Context Diet: this Bash output was')
  expect(text).toContain('FAIL src/api/user.test.ts')
  expect(text).toContain('Tests: 1 failed, 4000 passed')
  expect(text.length).toBeLessThan(raw.length / 5)
  expect(row.saves).toHaveLength(1)
  expect(row.saves[0]?.path).toMatch(/^\/repo\/\.context-diet\/out-\d{3}\.txt$/)
  expect(row.saves[0]?.text).toContain(raw)
  expect(text).toContain(row.saves[0]?.path ?? 'missing')
  expect(row.cuts[0]?.raw).toBe(raw.length)
})

test('a result given as text blocks stays text blocks', async () => {
  const row = dietBlocks([{ type: 'tool_result', tool_use_id: 'b', content: [{ type: 'text', text: bigLog() }] }], { kind: 'tool', tool: 'Bash' }, DEFAULT_PREFS, where)
  const blocks = (row.content[0] as unknown as { content: { type: string; text: string }[] }).content
  expect(blocks[0]?.type).toBe('text')
  expect(blocks[0]?.text).toContain('[Context Diet')
})

test('short outputs and Read results pass through untouched', async () => {
  expect(append('hello', 'Bash', 'toolu_2')).toBe('hello')
  const raw = bigLog()
  expect(append(raw, 'Read', 'toolu_3')).toBe(raw)
})

test('MCP prose stays whole, MCP JSON is cut', async () => {
  const prose = Array.from({ length: 600 }, (_, i) => `Paragraph ${i} of the documentation explains a feature.`).join('\n')
  expect(append(prose, 'mcp__docs__query', 'toolu_4')).toBe(prose)
  const json = JSON.stringify({ rows: Array.from({ length: 2000 }, (_, i) => ({ id: i, title: `row ${i}` })) })
  expect(append(json, 'mcp__db__query', 'toolu_5')).toContain('1,997 more items')
})

test('/diet off leaves outputs whole; /diet 16k sets the threshold', async ($, on) => {
  setup(on)
  const off = await $.command.run({ command: 'diet', args: 'off' } as never)
  expect(off.text).toContain('off')
  const raw = bigLog()
  expect(append(raw, 'Bash', 'toolu_6', { ...DEFAULT_PREFS, isOn: false })).toBe(raw)
  expect(append(raw, 'Bash', 'toolu_8', { ...DEFAULT_PREFS, threshold: raw.length + 1 })).toBe(raw)
  await $.command.run({ command: 'diet', args: 'on' } as never)
  const set = await $.command.run({ command: 'diet', args: '16k' } as never)
  expect(set.text).toContain('16,000 characters')
})

test('a command whose text names diet:off or .context-diet/ is left whole', async () => {
  const raw = bigLog()
  rememberCall('toolu_9', { tool: 'Bash', label: 'cat', command: 'cat /repo/.context-diet/out-001.txt' })
  expect(append(raw, 'Bash', 'toolu_9')).toBe(raw)
  rememberCall('toolu_10', { tool: 'Bash', label: 'make', command: 'make build # diet:off' })
  expect(append(raw, 'Bash', 'toolu_10')).toBe(raw)
  rememberCall('toolu_11', { tool: 'Bash', label: 'make', command: 'make build' })
  expect(append(raw, 'Bash', 'toolu_11')).not.toBe(raw)
})

test('the panel lists cuts and opens one to its saved path', async ($, on) => {
  setup(on)
  const demo = await $.command.run({ command: 'diet', args: 'demo' } as never)
  expect(demo.text).toContain('sample')
  const report = await $.command.run({ command: 'diet', args: 'report' } as never)
  expect(report.text).toContain('By tool')
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface } as never)
    expect(await ui.find({ type: 'Text', text: /CONTEXT DIET/ })).toBeDefined()
    const row = await ui.find({ type: 'Button', text: /Bash/ })
    expect(row).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /\.context-diet\/out-/ })).toBeUndefined()
    await ui.press({ key: row?.key ?? '' })
    expect(await ui.find({ type: 'Text', text: /\.context-diet\/out-/ })).toBeDefined()
    await ui.press({ key: row?.key ?? '' })
  }
})

test('a preview Claude Code saved to a file becomes a digest of the whole file', async () => {
  const raw = bigLog()
  const path = '/home/u/.claude/projects/p/s/tool-results/abc.txt'
  const preview = `<persisted-output>\nOutput too large (180.2KB). Full output saved to: ${path}\n\nPreview (first 2KB):\n> jest\nPASS src/unit/case0.test.ts\n...\n</persisted-output>`
  expect(persistedPath(preview)).toBe(path)
  const row = dietBlocks([{ type: 'tool_result', tool_use_id: 'p1', content: preview }], { kind: 'tool', tool: 'Bash' }, DEFAULT_PREFS, { ...where, persisted: { [path]: raw } })
  const text = (row.content[0] as unknown as { content: string }).content
  expect(text).toContain('Claude Code saved it to ' + path)
  expect(text).toContain('Tests: 1 failed, 4000 passed')
  expect(text.length).toBeLessThan(4000)
  expect(row.saves).toHaveLength(0)
  expect(row.cuts[0]?.isUpgrade).toBe(true)
  // without the file's text the preview stays as it is
  const kept = dietBlocks([{ type: 'tool_result', tool_use_id: 'p2', content: preview }], { kind: 'tool', tool: 'Bash' }, DEFAULT_PREFS, where)
  expect((kept.content[0] as unknown as { content: string }).content).toBe(preview)
})
