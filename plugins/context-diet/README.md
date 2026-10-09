# Context Diet

Trims huge tool outputs before they reach Claude's context: logs, test runs, builds, tables, JSON, diffs, grep results and file lists become short digests with the errors, the summary and the shape of the data. It knows jest, vitest, node --test, pytest, go test, cargo, tsc, eslint, package installs and docker build, and shows only what changed when a command runs again. The full output is saved to a file Claude can read.

Works in the Claude Code terminal and the Claude desktop app (Code tab). Requires Claude Code v2.1.287 or later.

- `/diet` opens the panel; `/diet report` prints the same in the transcript
- `/diet on` · `off` · `dry`, `/diet capture` (off by default), `/diet keep <text>`, `/diet 16k` (the threshold in characters), `/diet demo` · `reset`
- Add `# diet:off` to a command to keep its output whole

## What it runs, reads, writes and sends

Context Diet is one hooks module, `hooks/register.tsx`, with its compressors in `hooks/diet.ts`, `hooks/tools.ts` and `hooks/text.ts`: readable TypeScript with no dependencies.

**Sends: nothing.** It makes no network requests and sends no conversation, file or other data anywhere.

**Programs it starts: none.**

**What it reads.** Through the Claude Code mods API: the tool calls Claude makes (the tool's name, the Bash command, and the file or path a Read, Grep or Bash call names, to label each output and to notice when Claude opens a saved full output again) and the results of Bash, Grep, Glob and MCP tools as they are about to be stored. From disk: an output file Claude Code itself saved under `~/.claude/projects/…/tool-results/` when it moved a very long output out of the conversation, to digest the whole output instead of its first 2 KB.

**What it changes.** The text of those tool results that is longer than the threshold (8,000 characters by default): the model reads the digest with a note saying what was kept and where the full output is. It never changes Read, Edit, Write, WebFetch, or MCP answers that are not JSON, and never decides whether a tool runs.

**Commands it rewrites: none by default.** Only after you run `/diet capture on`, a Bash call that is a single test or build command (pytest, jest, vitest, go test, cargo test/build, tsc, eslint, npm/pnpm/yarn test/build/lint, make, gradle, mvn, dotnet test…; never one with pipes, redirects, `;`, `&`, background or watch modes) runs as `{ <command>\n} > .context-diet/run-NN.log 2>&1; __diet_rc=$?; cat .context-diet/run-NN.log; (exit $__diet_rc)`: the same command in the same shell, its output saved to a file and printed, with its own exit code. `/diet capture off` stops it.

**What it writes.** The full text of each output it shortens, to `.context-diet/out-NNN.txt` in the session's working directory (300 names, reused in turn), and with capture on the output of each captured command to `.context-diet/run-NN.log` (20 names, reused in turn), and `.context-diet/.gitignore` so git ignores the folder. A counter, all-time totals, the `/diet keep` list of each project and the last error are kept in the plugin's own store on your machine. The last outputs of up to 20 commands are held in memory for the session, to show what changed when a command runs again. It never writes build, settings, start-up or instruction files.

**Commands it adds.** `/diet`. It runs no slash commands itself.

**Events it hooks.** `session.append` (tool results only), to shorten long outputs; `tool.call`, to note which tool and command each result belongs to and, after the call, to keep a Bash call's own output for the digest; it passes every call on unchanged unless capture is on (above); `session.start`, to register `/diet`; `ui.render` and `ui.close`, for its panel.

Full documentation, screenshots and the changelog: https://github.com/drkokorev/context-diet
