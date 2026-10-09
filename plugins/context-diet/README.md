# Context Diet

Trims huge tool outputs before they reach Claude's context: logs, test runs, builds, tables, JSON, diffs, grep results and file lists become short digests with the errors, the summary and the shape of the data. The full output is saved to a file Claude can read.

Works in the Claude Code terminal and the Claude desktop app (Code tab). Requires Claude Code v2.1.287 or later.

- `/diet` opens the panel; `/diet report` prints the same in the transcript
- `/diet on` · `off`, `/diet 16k` (the threshold in characters), `/diet demo` · `reset`
- Add `# diet:off` to a command to keep its output whole

## What it runs, reads, writes and sends

Context Diet is two hooks modules, `hooks/register.tsx` and `hooks/diet.ts`, readable TypeScript with no dependencies.

**Sends: nothing.** It makes no network requests and sends no conversation, file or other data anywhere.

**Programs it starts: none.**

**What it reads.** Through the Claude Code mods API: the tool calls Claude makes (the tool's name and, for Bash, the command, to label each output) and the results of Bash, Grep, Glob and MCP tools as they are about to be stored. From disk: an output file Claude Code itself saved under `~/.claude/projects/…/tool-results/` when it moved a very long output out of the conversation, to digest the whole output instead of its first 2 KB.

**What it changes.** The text of those tool results that is longer than the threshold (8,000 characters by default): the model reads the digest with a note saying what was kept and where the full output is. It never changes Read, Edit, Write, WebFetch, or MCP answers that are not JSON, and never changes a tool's input or whether it runs.

**What it writes.** The full text of each output it shortens, to `.context-diet/out-NNN.txt` in the session's working directory (300 names, reused in turn), and `.context-diet/.gitignore` so git ignores the folder. A counter and all-time totals are kept in the plugin's own store on your machine. It never writes build, settings, start-up or instruction files.

**Commands it adds.** `/diet`. It runs no slash commands itself.

**Events it hooks.** `session.append` (tool results only), to shorten long outputs; `tool.call`, to note which tool and command each result belongs to, passing every call on unchanged; `session.start`, to register `/diet`; `ui.render` and `ui.close`, for its panel.

Full documentation, screenshots and the changelog: https://github.com/drkokorev/context-diet
