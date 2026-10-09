import { mock, test } from 'claude-code/testing'

// Prints the panel's real render trees with demo data, for README pictures.
// Run from the repo root: cp media/capture.tsx plugins/context-diet/tests/capture.test.tsx && claude plugin test plugins/context-diet | grep '^SCREEN' > media/screens.jsonl; rm plugins/context-diet/tests/capture.test.tsx

const PANE = {
  plugin: 'context-diet',
  component: 'Pane',
  requestId: 'context-diet',
  props: { title: 'Context Diet', isFocused: false, bodyColumns: 78, placement: 'dock', scroll: { offset: 0, bodyRows: 80 }, view: {} },
} as const

test('capture', async ($, on) => {
  mock.clock(on, { now: 1_800_000_000_000 })
  mock.store(on)
  on('ui.toast', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  await $.command.run({ command: 'diet', args: 'demo' } as never)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' } as never)
  const shot = async (name: string) => console.log(`SCREEN ${name} ${JSON.stringify(await ui.drawn())}`)
  await shot('panel')
  const row = await ui.find({ type: 'Button', text: /npm test/ })
  await ui.press({ key: row?.key ?? '' })
  await shot('panel-open')
  await ui.unmount()
})
