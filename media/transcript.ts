// Builds the "before / after" transcript for the README GIF from a realistic
// jest run, using the mod's own compressor. Run from the repo root: npx tsx media/transcript.ts
import { writeFileSync } from 'node:fs'
import { diet } from '../plugins/context-diet/hooks/diet'

const dirs = ['components', 'billing', 'auth', 'api', 'hooks', 'utils', 'pages', 'store', 'search', 'i18n']
const names = ['Button', 'Card', 'Modal', 'invoice', 'session', 'token', 'cart', 'checkout', 'format', 'router', 'query', 'cache', 'locale', 'upload', 'avatar', 'filters', 'table', 'chart', 'toast', 'menu']
let seed = 7
const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % n)
const lines = ['> acme-web@2.4.0 test', '> jest --ci', '']
for (let i = 0; i < 611; i += 1) {
  if (i === 377) {
    lines.push(
      'FAIL src/billing/invoice.test.ts',
      '  ● invoice › applies VAT for EU customers',
      '',
      '    expect(received).toBe(expected) // Object.is equality',
      '',
      '    Expected: 121.5',
      '    Received: 120',
      '',
      "      86 |   const total = invoice({ net: 100, country: 'DE' })",
      '      87 |',
      '    > 88 |   expect(total.gross).toBe(121.5)',
      '         |                       ^',
      '',
      '      at Object.<anonymous> (src/billing/invoice.test.ts:88:23)',
      '',
    )
  }
  const dir = dirs[rnd(dirs.length)]
  const name = names[rnd(names.length)]
  lines.push(`PASS src/${dir}/${name}${rnd(40)}.test.${rnd(2) ? 'tsx' : 'ts'} (${rnd(900) + 12} ms)`)
  if (rnd(9) === 0) lines.push(`  console.warn: [${name}] prop "size" is deprecated, use "variant"`)
}
lines.push('', 'Test Suites: 1 failed, 611 passed, 612 total', 'Tests:       1 failed, 4231 passed, 4232 total', 'Snapshots:   48 passed, 48 total', 'Time:        84.21 s', 'Ran all test suites.')
const raw = lines.join('\n')
const out = diet({ text: raw, tool: 'Bash', command: 'npm test', target: 2600 })
const path = '/Users/you/acme-web/.context-diet/out-007.txt'
const note = `[Context Diet: Bash output cut from ${raw.length.toLocaleString('en-US')} to ${out.text.length.toLocaleString('en-US')} characters. Kept: ${out.kept}. Full output: ${path}. Read it before answering about anything not shown here.]`
writeFileSync(new URL('./transcript.json', import.meta.url), JSON.stringify({ raw: lines, digest: out.text.split('\n'), note, rawChars: raw.length, keptChars: out.text.length + note.length }, null, 1))
console.log(raw.length, '->', out.text.length, out.kept)
console.log(out.text)
