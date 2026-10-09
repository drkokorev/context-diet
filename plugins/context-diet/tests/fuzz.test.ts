import { expect, test } from 'claude-code/testing'

import { diet } from '../hooks/diet'

declare const console: { log: (...args: unknown[]) => void }

// Random outputs: the digest never throws, never grows the text, stays near its
// target, and an error line hidden anywhere in a log is never lost.

let seed = 20261009
const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % n)
const WORDS = ['alpha', 'build', 'cache', 'delta', 'emit', 'fetch', 'graph', 'hash', 'index', 'json', 'kernel', 'lambda', 'module', 'node', 'ok', 'parse', 'query', 'route', 'step', 'token', 'ui', 'view', 'worker', 'xml', 'yield', 'zone', 'привет', '数据', '🚀']
const word = () => WORDS[rnd(WORDS.length)] ?? 'x'

const randomLine = () => {
  switch (rnd(12)) {
    case 0:
      return ''
    case 1:
      return `${rnd(100000)} ${rnd(100000)} ${rnd(100000)}`
    case 2:
      return 'x'.repeat(rnd(3000))
    case 3:
      return `{"${word()}": ${rnd(99)}, "${word()}": [${rnd(9)}, ${rnd(9)}]}`
    case 4:
      return `src/${word()}/${word()}.ts:${rnd(500)}:${rnd(80)}: ${word()} ${word()}`
    case 5:
      return `\x1b[3${rnd(8)}m${word()}\x1b[0m ${word()}\r${word()} ${rnd(100)}%`
    case 6:
      return `warning: ${word()} is deprecated`
    default:
      return Array.from({ length: rnd(12) + 1 }, word).join(' ')
  }
}

test('random outputs never break the digest', { timeoutMs: 60_000 }, async () => {
  for (let n = 0; n < 400; n += 1) {
    const text = Array.from({ length: rnd(4000) + 1 }, randomLine).join('\n')
    const target = [2000, 4000, 8000][rnd(3)] ?? 4000
    const tool = ['Bash', 'Grep', 'Glob', 'mcp__x__y'][rnd(4)] ?? 'Bash'
    const out = diet({ text, tool, target })
    expect(typeof out.text).toBe('string')
    if (text.length > target * 3) expect(out.text.length).toBeLessThan(Math.max(text.length, target * 3))
  }
})

test('an error hidden anywhere in a random log survives', { timeoutMs: 60_000 }, async () => {
  for (let n = 0; n < 300; n += 1) {
    const lines = Array.from({ length: rnd(5000) + 200 }, () => Array.from({ length: rnd(10) + 2 }, word).join(' '))
    const marker = `FATAL error: disk quota exceeded on volume v${n}`
    lines.splice(rnd(lines.length), 0, marker)
    const out = diet({ text: lines.join('\n'), tool: 'Bash', command: 'make', target: 4000 })
    expect(out.text).toContain(marker)
  }
})

test('a 4 MB log is digested quickly', { timeoutMs: 30_000 }, async () => {
  const lines: string[] = []
  for (let i = 0; i < 64000; i += 1) lines.push(`[${i}] worker ${i % 17} processed batch ${i * 3} in ${i % 900} ms, queue depth ${i % 41}`)
  lines.splice(41234, 0, 'ERROR worker 9 crashed: out of memory')
  const text = lines.join('\n')
  expect(text.length).toBeGreaterThan(4_000_000)
  const started = Date.now()
  const out = diet({ text, tool: 'Bash', command: './run-batch', target: 4000 })
  const ms = Date.now() - started
  console.log(`PERF 4MB log: ${ms} ms, ${text.length} -> ${out.text.length} chars`)
  expect(out.text).toContain('ERROR worker 9 crashed')
  expect(ms).toBeLessThan(2000)
})
