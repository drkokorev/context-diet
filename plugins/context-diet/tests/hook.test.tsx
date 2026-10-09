import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { captureCommand, DEFAULT_PREFS, dietBlocks, fullTextOf, persistedPath, rememberCall, sigOf } from '../hooks/register'

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
  expect(text).toContain('[Context Diet: Bash output cut from')
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
  expect(text).toContain('Claude Code saved to ' + path)
  expect(text).toContain('Tests: 1 failed, 4000 passed')
  expect(text.length).toBeLessThan(4000)
  expect(row.saves).toHaveLength(0)
  expect(row.cuts[0]?.isUpgrade).toBe(true)
  // without the file's text the preview stays as it is
  const kept = dietBlocks([{ type: 'tool_result', tool_use_id: 'p2', content: preview }], { kind: 'tool', tool: 'Bash' }, DEFAULT_PREFS, where)
  expect((kept.content[0] as unknown as { content: string }).content).toBe(preview)
})

test('a command signature skips cd and env assignments', async () => {
  expect(sigOf('Bash', 'cd app && FOO=1 npm test -- --ci')).toBe('npm test')
  expect(sigOf('Grep')).toBe('Grep')
  expect(sigOf('Bash', 'cd /x/y && python3 -m pytest -v -p no:cacheprovider')).toBe('pytest')
  expect(sigOf('Bash', 'npx jest --ci')).toBe('jest')
  expect(sigOf('Bash', 'uv run pytest tests/unit')).toBe('pytest')
  expect(sigOf('Bash', 'go test ./...')).toBe('go test')
  expect(sigOf('Bash', 'npm run build')).toBe('build')
})

test('a dry run measures the cut but leaves the output whole and saves nothing', async () => {
  const raw = bigLog()
  const row = cutRow(raw, 'Bash', 'dry1', { ...DEFAULT_PREFS, isDry: true })
  expect((row.content[0] as unknown as { content: string }).content).toBe(raw)
  expect(row.saves).toHaveLength(0)
  expect(row.cuts[0]?.isDry).toBe(true)
  expect(row.cuts[0]?.raw).toBe(raw.length)
})

test('commands kept whole in the project, and boosted ones, pass through', async () => {
  const raw = bigLog()
  rememberCall('keep1', { tool: 'Bash', label: 'npm test', command: 'npm test -- --ci' })
  const kept = dietBlocks([{ type: 'tool_result', tool_use_id: 'keep1', content: raw }], { kind: 'tool', tool: 'Bash' }, DEFAULT_PREFS, { ...where, keep: ['npm test'] })
  expect((kept.content[0] as unknown as { content: string }).content).toBe(raw)
  rememberCall('boost1', { tool: 'Bash', label: 'npm test', command: 'npm test' })
  const boosted = dietBlocks([{ type: 'tool_result', tool_use_id: 'boost1', content: raw }], { kind: 'tool', tool: 'Bash' }, { ...DEFAULT_PREFS, boost: { 'npm test': 100 } }, where)
  expect((boosted.content[0] as unknown as { content: string }).content).toBe(raw)
})

test('the second run of a command shows what changed', async () => {
  // eight failures, one of them replaced by another between the runs
  const run = (names: string[]) =>
    [
      '> jest',
      Array.from({ length: 3000 }, (_, i) => `PASS src/unit/case${i}.test.ts (${(i * 7) % 90} ms)`).join('\n'),
      ...names.flatMap(n => [`FAIL src/api/${n}.test.ts`, `  ● ${n} › breaks on input`, '    expect(received).toBe(expected)', '    Expected: 200', '    Received: 500', `      at Object.<anonymous> (src/api/${n}.test.ts:12:5)`]),
      `Tests: ${names.length} failed, 3000 passed`,
    ].join('\n')
  const names = ['user', 'order', 'invoice', 'refund', 'stock', 'search', 'login', 'token']
  const first = run(names)
  const second = run([...names.slice(0, 7), 'cart'])
  rememberCall('run2', { tool: 'Bash', label: 'npm test', command: 'npm test' })
  const runs = new Map([['npm test', { raw: first, at: 1_800_000_000_000 - 120_000 }]])
  const row = dietBlocks([{ type: 'tool_result', tool_use_id: 'run2', content: second }], { kind: 'tool', tool: 'Bash' }, DEFAULT_PREFS, { ...where, runs })
  const text = (row.content[0] as unknown as { content: string }).content
  expect(row.cuts[0]?.kind).toBe('delta')
  expect(text).toContain('Same command as at')
  expect(text).toContain('FAIL src/api/cart.test.ts')
  expect(text).toContain('FAIL src/api/token.test.ts')
  expect(row.seen[0]?.command).toBe('npm test')
  expect(row.saves[0]?.text).toBe(second)
})

test('the whole output of a Bash call is taken from its result record', async () => {
  expect(fullTextOf({ result: { stdout: 'out', stderr: 'err', interrupted: false } })).toBe('out\nerr')
  expect(fullTextOf({ isError: true, result: 'Exit code 1\nboom' })).toBe('Exit code 1\nboom')
  expect(fullTextOf({ result: { stdout: 'x', stderr: '', persistedOutputPath: '/p' } })).toBeUndefined()
  expect(fullTextOf({ deny: 'no' })).toBeUndefined()
})

test('a failing output Claude Code shortened is digested whole, failures at the end included', async () => {
  const whole = [
    '============================= test session starts ==============================',
    'collected 600 items',
    Array.from({ length: 597 }, (_, i) => `tests/test_m.py::test_c[${i}] PASSED                [ ${Math.floor(i / 6)}%]`).join('\n'),
    '=================================== FAILURES ===================================',
    '__________________________ test_refund_rounds_half_up __________________________',
    "E       AssertionError: assert Decimal('6.59') == Decimal('6.60')",
    'tests/test_refunds.py:10: AssertionError',
    '=========================== short test summary info ============================',
    'FAILED tests/test_refunds.py::test_refund_rounds_half_up - AssertionError',
    '================= 1 failed, 597 passed in 0.14s ==================',
  ].join('\n')
  const shown = `Exit code 1\n${whole.slice(0, 5000)}\n\n... [${whole.length - 10000} characters truncated] ...\n\n${whole.slice(15000, 20000)}`
  rememberCall('rec1', { tool: 'Bash', label: 'pytest', command: 'python3 -m pytest -v' })
  const row = dietBlocks([{ type: 'tool_result', tool_use_id: 'rec1', content: shown }], { kind: 'tool', tool: 'Bash' }, DEFAULT_PREFS, { ...where, fulls: new Map([['rec1', whole]]) })
  const text = (row.content[0] as unknown as { content: string }).content
  expect(text).toContain('would have shown only')
  expect(text).toContain("Decimal('6.59')")
  expect(text).toContain('tests/test_refunds.py:10')
  expect(text).toContain('1 failed, 597 passed')
  expect(row.cuts[0]?.recoveredFrom).toBe(shown.length)
  expect(row.cuts[0]?.raw).toBe(shown.length)
  expect(row.saves[0]?.text).toBe(whole)
})

test('capture wraps test and build commands only', async () => {
  const f = '/repo/.context-diet/run-01.log'
  const wrapped = captureCommand('cd app && python3 -m pytest -v', f)
  expect(wrapped).toBe("{ cd app && python3 -m pytest -v\n} > '/repo/.context-diet/run-01.log' 2>&1; __diet_rc=$?; cat '/repo/.context-diet/run-01.log'; (exit $__diet_rc)")
  for (const ok of ['npm test', 'npx jest --ci', 'go test ./...', 'cargo build', 'tsc --noEmit', 'pnpm run lint', 'make check', 'FOO=1 vitest run']) expect(captureCommand(ok, f)).toBeDefined()
  for (const no of ['ls -la', 'npm test | tail -5', 'pytest > out.txt', 'npm test && rm -rf x', 'jest --watch', 'cat file', 'npm test # diet:off', 'git push', 'pytest; echo done', 'npm test &']) expect(captureCommand(no, f)).toBeUndefined()
})
