import { expect, test } from 'claude-code/testing'

import { detectKind, diet, dietLog } from '../hooks/diet'

const lines = (n: number, make: (i: number) => string) => Array.from({ length: n }, (_, i) => make(i)).join('\n')

test('a long build log keeps its errors, head and tail', async () => {
  const log = [
    '> app@1.0.0 build',
    lines(3000, i => `[${i}] compiling module src/feature${i}/index.ts (${i * 3} ms)`),
    'src/api/user.ts(42,7): error TS2322: Type string is not assignable to type number.',
    lines(1500, i => `  emitting chunk vendor-${i}.js ${i} kB`),
    'Build failed with 1 error.',
  ].join('\n')
  const out = diet({ text: log, tool: 'Bash', command: 'npm run build', target: 4000 })
  expect(out.kind).toBe('log')
  expect(out.text.length).toBeLessThan(6000)
  expect(out.text).toContain('error TS2322')
  expect(out.text).toContain('Build failed with 1 error.')
  expect(out.text).toContain('> app@1.0.0 build')
  expect(out.text).toMatch(/similar lines|lines cut/)
})

test('identical lines fold into one with a count', async () => {
  const out = dietLog(lines(500, () => 'npm WARN deprecated left-pad@1.0.0'), 4000)
  expect(out.text).toContain('[×500]')
  expect(out.text.split('\n').length).toBe(1)
})

test('progress bars and colors are stripped', async () => {
  const bar = Array.from({ length: 200 }, (_, i) => `\x1b[32m${i}%\x1b[0m`).join('\r')
  const out = dietLog(`${bar}\ndone`, 4000)
  expect(out.text).toBe('199%\ndone')
})

test('JSON becomes a skeleton with every key and array counts', async () => {
  const data = { total: 5000, items: Array.from({ length: 5000 }, (_, i) => ({ id: i, name: `user ${i}`, email: `u${i}@example.com`, bio: 'x'.repeat(400) })) }
  const text = JSON.stringify(data, null, 2)
  expect(detectKind(text, 'mcp__db__query')).toBe('json')
  const out = diet({ text, tool: 'mcp__db__query', target: 4000 })
  expect(out.kind).toBe('json')
  expect(out.text.length).toBeLessThan(4000)
  expect(out.text).toContain('"total": 5000')
  expect(out.text).toContain('4,997 more items')
  expect(out.text).toContain('keys: id, name, email, bio')
})

test('a diff keeps code hunks and reduces lockfiles to counts', async () => {
  const lock = ['diff --git a/package-lock.json b/package-lock.json', '--- a/package-lock.json', '+++ b/package-lock.json', '@@ -1,3 +1,3 @@', lines(4000, i => `+    "dep-${i}": "^1.${i}.0",`)].join('\n')
  const code = ['diff --git a/src/app.ts b/src/app.ts', '--- a/src/app.ts', '+++ b/src/app.ts', '@@ -10,6 +10,7 @@ export function app() {', '   const a = 1', '-  const b = 2', '+  const b = 3', '+  log(b)'].join('\n')
  const out = diet({ text: `${code}\n${lock}`, tool: 'Bash', command: 'git diff', target: 4000 })
  expect(out.kind).toBe('diff')
  expect(out.text).toContain('+  const b = 3')
  expect(out.text).toContain('lockfile/generated: +4000')
  expect(out.text).not.toContain('dep-3999')
})

test('grep results group by file with the first matches', async () => {
  const text = lines(2000, i => `src/module${i % 40}/file.ts:${i + 1}:  const value${i} = useThing(${i})`)
  expect(detectKind(text, 'Bash', 'rg useThing')).toBe('grep')
  const out = diet({ text, tool: 'Bash', command: 'rg useThing', target: 4000 })
  expect(out.kind).toBe('grep')
  expect(out.text).toContain('2,000 matches in 40 files')
  expect(out.text).toContain('src/module0/file.ts (50)')
  expect(out.text.length).toBeLessThan(4500)
})

test('a file list groups by directory', async () => {
  const text = lines(3000, i => `node_modules/pkg${i % 30}/lib/file${i}.js`)
  expect(detectKind(text, 'Bash', 'find . -name "*.js"')).toBe('paths')
  const out = diet({ text, tool: 'Bash', command: 'find . -name "*.js"', target: 4000 })
  expect(out.text).toContain('3,000 paths in 30 directories, all under node_modules/')
  expect(out.text).toContain('pkg0/lib/ (100)')
})

test('a CSV keeps its header and exact first and last rows, nothing folded', async () => {
  const text = ['id,name,price,qty', lines(3000, i => `${i + 1},item ${i + 1},${(i * 1.37).toFixed(2)},${i % 17}`)].join('\n')
  expect(detectKind(text, 'Bash', 'cat data.csv')).toBe('table')
  const out = diet({ text, tool: 'Bash', command: 'cat data.csv', target: 4000 })
  expect(out.kind).toBe('table')
  expect(out.text).toContain('Table: 3,000 rows × 4 columns (id, name, price, qty)')
  expect(out.text).toContain('1,item 1,0.00,0')
  expect(out.text).toContain('3000,item 3000,4108.63,7')
  expect(out.text).not.toContain('similar')
  expect(out.text).toMatch(/rows cut: output lines \d+–\d+/)
})

test('a list of numbers is data: cut in the middle, never folded as similar', async () => {
  const out = diet({ text: lines(5000, i => String(i * 7)), tool: 'Bash', target: 4000 })
  expect(out.kind).toBe('table')
  expect(out.text).not.toContain('similar')
  expect(out.text).toContain('34993')
})

test('log lines with words still fold when only their numbers differ', async () => {
  const out = dietLog(lines(300, i => `Downloading package number ${i} from the registry`), 4000)
  expect(out.text).toContain('298 similar lines')
})

test('a failure in the middle survives a flood of warnings', async () => {
  const log = [
    '> jest --ci',
    lines(300, i => `PASS src/area${i % 7}/name${i}.test.ts (${i} ms)\n  console.warn: [w${i % 5}] prop "size" is deprecated, use "variant"`),
    'FAIL src/billing/invoice.test.ts',
    '  ● invoice › applies VAT for EU customers',
    '    Expected: 121.5',
    '    Received: 120',
    '      at Object.<anonymous> (src/billing/invoice.test.ts:88:23)',
    lines(300, i => `PASS src/area${i % 7}/other${i}.test.ts (${i} ms)\n  console.warn: [w${i % 5}] prop "size" is deprecated, use "variant"`),
    'Tests: 1 failed, 600 passed, 601 total',
  ].join('\n')
  const out = diet({ text: log, tool: 'Bash', command: 'npm test', target: 2600 })
  expect(out.text).toContain('FAIL src/billing/invoice.test.ts')
  expect(out.text).toContain('Expected: 121.5')
  expect(out.text).toContain('Received: 120')
  expect(out.text).toContain('invoice.test.ts:88:23')
  expect(out.text).toContain('Tests: 1 failed')
})
