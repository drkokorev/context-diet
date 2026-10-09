# Changelog

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
