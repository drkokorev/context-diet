# Changelog

## 0.2.0 (2026-10-09)

- Digests that know the tool: jest and vitest, `node --test`, pytest, `go test`, cargo, tsc, eslint, npm / yarn / pnpm / pip install, `docker build`. Every failure or error with its message and stack, the summary; passing tests counted, not listed; noise shown once per kind with a count
- Errors always outrank warnings, so a failure is never pushed out by deprecation noise; passing lines such as `PASS errorHandler.test.ts` no longer count as errors; Russian error and warning words are recognised
- Running a command again shows only what changed since the last run, when that is shorter
- The panel and report count how often Claude reopened a saved full output; a command whose outputs keep getting reopened is cut only when twice as long
- `/diet dry`: measure only, change nothing
- `/diet keep <text>` and `/diet unkeep <text>`: keep a command's output whole in this project
- A shorter note above each digest; saved outputs are exactly what the tool printed, with no header line
- Fails safe: if a full output cannot be saved, the output reaches Claude whole and `/diet report` shows why. The working directory is asked for on every output, so a session that changes directory keeps working
- Tests: realistic outputs of every tool above, hard cases, 700 random outputs, a 4 MB log

## 0.1.0 (2026-10-09)

First public release.

- Digests long Bash, Grep, Glob and MCP JSON outputs before they are stored in the conversation; the full text goes to `.context-diet/out-NNN.txt` (self-gitignored, 300 names reused in turn)
- Logs and test runs: every error with context first, then each distinct warning once, the first and last lines, the summary; repeated lines folded
- Tables, CSV and columns of numbers: the header and the exact first and last rows, never folded
- JSON: the structure with every key, the first items of each array and the count of the rest
- Diffs: every file and its hunks, lockfiles and generated files reduced to counts
- grep results grouped by file, file lists grouped by directory
- Outputs Claude Code already saved to a file get a digest of the whole file in place of its first 2 KB
- `/diet` panel and report, status line, `/diet on|off|<chars>|demo|reset`, `# diet:off` per command
