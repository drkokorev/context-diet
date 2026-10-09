import { expect, test } from 'claude-code/testing'

import { diet, dietDelta } from '../hooks/diet'

// Realistic outputs of the tools Context Diet knows, and the hard cases for the
// generic digest. Each test names the facts an agent needs and checks they survive.

let seed = 11
const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % n)
const many = (n: number, make: (i: number) => string) => Array.from({ length: n }, (_, i) => make(i)).join('\n')
const cut = (text: string, command = '', target = 4000) => diet({ text, tool: 'Bash', command, target })
const expectAll = (text: string, facts: string[]) => facts.forEach(f => expect(text).toContain(f))

test('jest: five failures spread through the run all survive', async () => {
  const failAt = new Set([40, 300, 800, 1500, 2900])
  const log = ['> jest --ci']
  for (let i = 0; i < 3000; i += 1) {
    if (failAt.has(i)) log.push(`FAIL src/f${i}.test.ts`, `  ● suite${i} › case`, '', `    Expected: ${i}`, `    Received: ${i + 1}`, '', `      at Object.<anonymous> (src/f${i}.test.ts:${i % 90 + 1}:7)`, '')
    else log.push(`PASS src/p${i}.test.ts (${rnd(900)} ms)`)
  }
  log.push('Tests:       5 failed, 2995 passed, 3000 total')
  const out = cut(log.join('\n'), 'npx jest')
  expect(out.kind).toBe('jest')
  for (const i of failAt) expectAll(out.text, [`FAIL src/f${i}.test.ts`, `Expected: ${i}`, `Received: ${i + 1}`])
  expect(out.text).toContain('Tests:       5 failed')
})

test('jest: a failure in the very first lines survives', async () => {
  const log = ['FAIL src/first.test.ts', '  ● first › breaks', '    TypeError: x is not a function', many(2000, i => `PASS src/p${i}.test.ts (${i} ms)`), 'Tests: 1 failed, 2000 passed']
  const out = cut(log.join('\n'), 'npm test')
  expectAll(out.text, ['FAIL src/first.test.ts', 'TypeError: x is not a function', 'Tests: 1 failed'])
})

test('error in a passing file name is not treated as an error', async () => {
  const log = [many(1500, i => `PASS src/errorHandler${i}.test.ts (${i} ms)`), 'FAIL src/real.test.ts', '  ● real › fails', '    Expected: 1', 'Tests: 1 failed, 1500 passed']
  const out = cut(log.join('\n'), 'npm test')
  expect(out.text).toContain('FAIL src/real.test.ts')
  expect((out.text.match(/errorHandler/g) ?? []).length).toBeLessThan(5)
})

test('vitest output', async () => {
  const log = [
    ' RUN  v2.1.8 /app',
    many(400, i => ` ✓ src/m${i}.test.ts (${rnd(9) + 1} tests) ${rnd(90)}ms`),
    ' ❯ src/cart.test.ts (3 tests | 1 failed) 12ms',
    '   × cart > applies coupon',
    '     → expected 90 to be 81',
    ' FAIL  src/cart.test.ts > cart > applies coupon',
    'AssertionError: expected 90 to be 81',
    ' ❯ src/cart.test.ts:22:18',
    ' Test Files  1 failed | 400 passed (401)',
    '      Tests  1 failed | 1990 passed (1991)',
  ].join('\n')
  const out = cut(log, 'npx vitest run')
  expect(out.kind).toBe('jest')
  expectAll(out.text, ['applies coupon', 'expected 90 to be 81', 'src/cart.test.ts:22:18', 'Test Files  1 failed'])
})

test('node --test output', async () => {
  const log = [
    many(600, i => `✔ case ${i} (${rnd(5)}.${rnd(9)}ms)`),
    '✖ refund rounds half up (1.2ms)',
    '  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:',
    '  6.59 !== 6.6',
    '      at TestContext.<anonymous> (file:///app/test/refund.test.js:14:10)',
    'ℹ tests 601',
    'ℹ pass 600',
    'ℹ fail 1',
  ].join('\n')
  const out = cut(log, 'node --test')
  expect(out.kind).toBe('node-test')
  expectAll(out.text, ['✖ refund rounds half up', '6.59 !== 6.6', 'refund.test.js:14:10', 'ℹ fail 1'])
})

test('pytest: two failures, one very long, plus the summary', async () => {
  const log = [
    '============================= test session starts ==============================',
    'platform linux -- Python 3.12.4, pytest-8.3.2',
    'collected 812 items',
    '',
    many(810, i => `tests/test_m${i % 40}.py::test_c${i} PASSED`),
    'tests/test_orders.py::test_refund FAILED',
    'tests/test_users.py::test_signup FAILED',
    '=================================== FAILURES ===================================',
    '_________________________________ test_refund __________________________________',
    '>       assert refund(order, pct=33) == Decimal("6.60")',
    "E       AssertionError: assert Decimal('6.59') == Decimal('6.60')",
    'tests/test_orders.py:42: AssertionError',
    '_________________________________ test_signup __________________________________',
    many(200, i => `    frame ${i} in deep call`),
    "E       KeyError: 'email'",
    'tests/test_users.py:88: KeyError',
    '=========================== short test summary info ============================',
    'FAILED tests/test_orders.py::test_refund - AssertionError',
    "FAILED tests/test_users.py::test_signup - KeyError: 'email'",
    '======================== 2 failed, 810 passed in 31.02s ========================',
  ].join('\n')
  const out = cut(log, 'python -m pytest')
  expect(out.kind).toBe('pytest')
  expectAll(out.text, ["Decimal('6.59')", 'tests/test_orders.py:42', "KeyError: 'email'", 'tests/test_users.py:88', 'FAILED tests/test_users.py::test_signup', '2 failed, 810 passed'])
  expect(out.text).not.toContain('test_c500 PASSED')
})

test('go test with a failure and a panic', async () => {
  const log = [
    many(300, i => `=== RUN   TestCase${i}\n--- PASS: TestCase${i} (0.00s)`),
    '=== RUN   TestTotal',
    '    cart_test.go:31: total = 99, want 100',
    '--- FAIL: TestTotal (0.00s)',
    'panic: runtime error: index out of range [3] with length 3',
    'goroutine 7 [running]:',
    'example.com/cart.Pick(...)',
    '\t/app/cart/pick.go:12 +0x1d',
    'FAIL\texample.com/cart\t0.012s',
    many(20, i => `ok  \texample.com/pkg${i}\t0.0${i % 9}s`),
  ].join('\n')
  const out = cut(log, 'go test ./...')
  expect(out.kind).toBe('go-test')
  expectAll(out.text, ['cart_test.go:31: total = 99, want 100', '--- FAIL: TestTotal', 'index out of range [3]', 'pick.go:12', 'FAIL\texample.com/cart'])
})

test('cargo build: the error survives 300 compile lines and repeated warnings', async () => {
  const log = [
    many(300, i => `   Compiling crate-${i} v0.${i}.0`),
    many(60, i => `warning: unused variable: \`v${i}\`\n  --> src/lib.rs:${i + 1}:9\n   |\n${i + 1} |     let v${i} = 1;\n   |         ^^ help: prefix it with an underscore\n`),
    'error[E0308]: mismatched types',
    '  --> src/main.rs:12:18',
    '   |',
    '12 |     let x: u32 = "hi";',
    '   |            ---   ^^^^ expected `u32`, found `&str`',
    '',
    'error: could not compile `app` (bin "app") due to 1 previous error; 60 warnings emitted',
  ].join('\n')
  const out = cut(log, 'cargo build')
  expect(out.kind).toBe('cargo')
  expectAll(out.text, ['error[E0308]: mismatched types', 'src/main.rs:12:18', 'expected `u32`', 'could not compile', '60 warnings of 1 kind'])
})

test('tsc: every file with errors is named', async () => {
  const lines: string[] = []
  for (let f = 0; f < 40; f += 1) for (let e = 0; e < 8; e += 1) lines.push(`src/mod${f}/index.ts(${e * 7 + 1},5): error TS2322: Type 'string' is not assignable to type 'number'.`)
  lines.push('Found 320 errors in 40 files.')
  const out = cut(lines.join('\n'), 'npx tsc --noEmit')
  expect(out.kind).toBe('tsc')
  for (let f = 0; f < 40; f += 1) expect(out.text).toContain(`src/mod${f}/index.ts(1,5)`)
  expect(out.text).toContain('Found 320 errors')
})

test('eslint: errors kept, warnings shown once per rule', async () => {
  const lines: string[] = []
  for (let f = 0; f < 60; f += 1) {
    lines.push(`/app/src/c${f}.tsx`)
    for (let w = 0; w < 6; w += 1) lines.push(`  ${w + 3}:5  warning  Unexpected console statement  no-console`)
    if (f === 33) lines.push('  9:12  error  React Hook useEffect has a missing dependency: \'id\'  react-hooks/exhaustive-deps')
    lines.push('')
  }
  lines.push('✖ 361 problems (1 error, 360 warnings)')
  const out = cut(lines.join('\n'), 'npx eslint .')
  expect(out.kind).toBe('eslint')
  expectAll(out.text, ['/app/src/c33.tsx', 'missing dependency', '✖ 361 problems', 'no-console ×360'])
})

test('npm install: the error and the summary, not 200 deprecation lines', async () => {
  const log = [
    many(200, i => `npm WARN deprecated pkg-${i}@1.0.${i}: this package is no longer supported`),
    'npm ERR! code ERESOLVE',
    'npm ERR! ERESOLVE unable to resolve dependency tree',
    'npm ERR! Found: react@19.0.0',
    'npm ERR! Could not resolve dependency: peer react@"^18" from some-lib@2.1.0',
  ].join('\n')
  const out = cut(log, 'npm install')
  expect(out.kind).toBe('install')
  expectAll(out.text, ['ERESOLVE unable to resolve', 'peer react@"^18" from some-lib@2.1.0', '200 warnings of 1 kind'])
  expect((out.text.match(/WARN deprecated/g) ?? []).length).toBe(1)
})

test('pip install failure', async () => {
  const log = [
    many(300, i => `Collecting pkg${i}==1.${i}\n  Downloading pkg${i}-1.${i}-py3-none-any.whl (${i} kB)`),
    'ERROR: Could not find a version that satisfies the requirement torch==9.9 (from versions: 2.3.0, 2.4.0)',
    'ERROR: No matching distribution found for torch==9.9',
  ].join('\n')
  const out = cut(log, 'pip install -r requirements.txt')
  expectAll(out.text, ['torch==9.9 (from versions', 'No matching distribution'])
})

test('docker build: the failing step and its output', async () => {
  const log = [
    many(30, i => `#${i + 1} [stage ${i % 3} ${i + 1}/30] RUN step ${i}\n#${i + 1} ${i * 0.1}s ${'progress '.repeat(5)}\n#${i + 1} DONE ${i}.0s`),
    '#31 [stage 2 30/30] RUN npm ci',
    '#31 12.4 npm ERR! code E401',
    '#31 12.4 npm ERR! Incorrect or missing password.',
    '#31 ERROR: process "/bin/sh -c npm ci" did not complete successfully: exit code: 1',
    '------',
    ' > [stage 2 30/30] RUN npm ci:',
    '12.4 npm ERR! Incorrect or missing password.',
    '------',
    'ERROR: failed to solve: process "/bin/sh -c npm ci" did not complete successfully: exit code: 1',
  ].join('\n')
  const out = cut(log, 'docker build .')
  expect(out.kind).toBe('docker')
  expectAll(out.text, ['RUN npm ci', 'Incorrect or missing password', 'failed to solve'])
})

test('Python, Java and Go stack traces keep the exception and its frames', async () => {
  const noise = (tag: string) => many(800, i => `${tag} INFO handled request ${i} in ${rnd(90)} ms`)
  const python = [noise('py'), 'Traceback (most recent call last):', '  File "/app/server.py", line 88, in handle', '    total = compute(order)', '  File "/app/billing.py", line 12, in compute', '    return order["net"] * VAT', 'KeyError: \'net\'', noise('py')].join('\n')
  expectAll(cut(python).text, ['Traceback', 'billing.py", line 12', "KeyError: 'net'"])
  const java = [noise('java'), 'Exception in thread "main" java.lang.NullPointerException: Cannot invoke "User.getName()"', '\tat com.acme.Billing.total(Billing.java:42)', '\tat com.acme.Main.main(Main.java:9)', noise('java')].join('\n')
  expectAll(cut(java).text, ['java.lang.NullPointerException', 'Billing.java:42'])
  const go = [noise('go'), 'panic: assignment to entry in nil map', '', 'goroutine 1 [running]:', 'main.main()', '\t/app/main.go:14 +0x2c', 'exit status 2', noise('go')].join('\n')
  expectAll(cut(go).text, ['panic: assignment to entry in nil map', 'main.go:14'])
})

test('a single-line 2 MB JSON becomes a skeleton', async () => {
  const json = JSON.stringify({ items: Array.from({ length: 12000 }, (_, i) => ({ id: i, sku: `S-${i}`, tags: ['a', 'b'], note: 'x'.repeat(120) })) })
  expect(json.length).toBeGreaterThan(1_500_000)
  const out = cut(json, 'curl -s api/items')
  expect(out.kind).toBe('json')
  expect(out.text.length).toBeLessThan(4000)
  expectAll(out.text, ['"items"', '11,997 more items', 'keys: id, sku, tags, note'])
})

test('a Russian log keeps its errors', async () => {
  const log = [many(1200, i => `ИНФО обработан заказ ${i} за ${rnd(90)} мс`), 'ОШИБКА: не удалось подключиться к базе данных postgres:5432', many(600, i => `ИНФО повтор ${i}`), 'Предупреждение: устаревший параметр --legacy']
  const out = cut(log.join('\n'))
  expectAll(out.text, ['ОШИБКА: не удалось подключиться', 'устаревший параметр'])
})

test('interleaved stdout and stderr keep the error', async () => {
  const log = many(2000, i => (i === 1234 ? 'stderr | Error: EACCES: permission denied, open \'/etc/app.conf\'' : i % 3 ? `stdout | step ${i} ok` : `stderr | debug: tick ${i}`))
  expect(cut(log).text).toContain("EACCES: permission denied, open '/etc/app.conf'")
})

test('a repeated run shows only what changed', async () => {
  const run = (failing: string[]) => {
    const lines = ['> jest --ci']
    const order = Array.from({ length: 800 }, (_, i) => i).sort(() => rnd(3) - 1)
    for (const i of order) lines.push(`PASS src/p${i}.test.ts (${rnd(900)} ms)`)
    for (const f of failing) lines.push(`FAIL src/${f}.test.ts`, `  ● ${f} › breaks`, `    Expected: 1`, `    Received: 2`)
    lines.push(`Tests:       ${failing.length} failed, 800 passed, ${800 + failing.length} total`, `Time:        ${rnd(90)}.${rnd(99)} s`)
    return lines.join('\n')
  }
  const first = run(['invoice'])
  const second = run(['cart'])
  const out = dietDelta(first, second, 4000, '14:02')
  expect(out).toBeDefined()
  expect(out?.kind).toBe('delta')
  expectAll(out?.text ?? '', ['Same command as at 14:02', 'New in this run:', 'FAIL src/cart.test.ts', 'Gone since then:', 'FAIL src/invoice.test.ts', 'End of this run:', '1 failed, 800 passed'])
  expect((out?.text ?? '').length).toBeLessThan(1500)
  const same = dietDelta(first, run(['invoice']), 4000, '14:02')
  expect(same?.text).toContain('and the same output')
  expect(dietDelta(first, many(900, i => `something else entirely ${i}`), 4000, '14:02')).toBeUndefined()
})
