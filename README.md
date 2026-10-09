# Context Diet for Claude Code

**Huge tool outputs, trimmed before they fill Claude's context. Nothing is lost: the full text is one Read away.**

Context Diet is a [Claude Code mod](https://code.claude.com/docs/en/plugins/mods/overview). When a command prints a wall of text (a test run, a build log, a 5,000-row JSON, a `git diff` with a lockfile), Claude gets a short digest instead: the errors with their context, the summary, the shape of the data, and the path to a file with the full output. When Claude needs more, it reads that file.

**Works in** the Claude Code terminal and the **Claude desktop app** (Code tab). Tested on macOS.

[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
![Claude Code 2.1.287+](https://img.shields.io/badge/Claude%20Code-2.1.287%2B-d97757)
![Mod](https://img.shields.io/badge/type-mod-blue)

![Context Diet: before and after](docs/img/demo.gif)

## Install

In Claude Code:

```
/plugin marketplace add drkokorev/context-diet
/plugin install context-diet@context-diet
```

Or from your shell:

```bash
claude plugin marketplace add drkokorev/context-diet
claude plugin install context-diet@context-diet
```

There is nothing to set up. Run `/diet demo` to see the panel filled in, and `/diet reset` to clear it.

## Why

- **Logs eat the context.** One test run of 600 suites is 30,000 characters, about 7,600 tokens, almost all of them `PASS` lines. A few of those and the context is half full, compaction comes sooner, and Claude forgets what you said at the start.
- **The very long ones hide the failure.** Past about 30,000 characters, Claude Code saves the output to a file and shows Claude only its first 2 KB. A failure in the middle or at the end isn't in that preview, so Claude has to open the file first. Context Diet replaces the preview with a digest of the whole file, so the failure is right there.

## What Claude gets

Every digest starts with a note like this:

```
[Context Diet: this Bash output was 30,372 characters (≈7.6k tokens), cut to 1,798.
Kept: the first and last lines, 9 of 9 error lines with context, 5 of 5 distinct warnings;
repeats folded. The full output is saved at /path/to/project/.context-diet/out-007.txt.
Read it with offset/limit, or grep it, if you need anything that was cut. If your answer
depends on what is not shown here, read the file first instead of guessing.]
```

What it keeps depends on what the output is:

| Output | What stays |
| --- | --- |
| **Logs, tests, builds** | Every error with two lines before and three after, then each distinct warning once, the first and last lines, the summary. Identical lines and lines that differ only in numbers ("Compiling crate_1 … crate_1500") fold into one with a count |
| **Tables, CSV, columns of numbers** | The header and the first and last rows, exactly. Rows are never folded or summarized; the note says which lines were left out |
| **JSON** (Bash or MCP) | The structure: every key, the first items of each array with the count of the rest and their keys, long strings shortened |
| **Diffs** | Every file with its +/− counts and its hunks; lockfiles and generated files (`package-lock.json`, `yarn.lock`, `*.min.js`, `dist/`…) reduced to counts |
| **grep results** | Match counts for every file and the first matches in each, as many as fit |
| **File lists** (`find`, Glob) | Grouped by directory with counts and the first names, the shared path prefix written once |

Outputs from Bash, Grep, Glob and MCP tools (JSON only) longer than 8,000 characters (≈2k tokens) get a digest; shorter ones pass as they are. The threshold is one command away: `/diet 16k`.

## Does it make Claude's answers worse?

That is the right question. We tested it: seven tasks with a known answer, each given to two fresh Claude agents (Sonnet), one with Context Diet and one without. Each agent ran the same command first and then could use any tool it liked.

| Task | Output | Without | With Context Diet |
| --- | --- | --- | --- |
| Which test failed, where, expected vs received | Jest log, 155k chars, failure in the middle | ✅ 2 steps (had to open the file) | ✅ **1 step** |
| Build error and warning | Webpack log, 18k | ✅ 1 step, 61.2k tokens | ✅ 1 step, **52.5k** |
| A row's values, and the region with most units | CSV, 3,000 rows | ✅ 2 steps | ✅ 2 steps |
| A user's email by id, and the number of admins | JSON, 800 users | ✅ 2 steps | ✅ 2 steps |
| The one call with options among 600 matches | grep, 100k | ✅ 3 steps | ✅ **1 step** |
| What changed in the code, next to a huge lockfile diff | diff, 226k | ✅ 2 steps | ✅ **1 step** |
| Which pytest failed and why | pytest log, 19k | ✅ 1 step, 58.7k tokens | ✅ 1 step, **51.2k** |
| **Total** | | **7 of 7, 13 tool calls** | **7 of 7, 8 tool calls** |

- **Same accuracy.** Both groups answered all seven correctly.
- **Fewer steps.** With the digest, the answer was usually already on screen: 8 tool calls instead of 13.
- **Fewer tokens on mid-size outputs.** On the two logs under 30k characters, each task used 7–9k fewer tokens (about 15%). On the very long ones the saving is small, because Claude Code already trims those; the win there is the missing step.
- **On data, Claude still reads the file.** For the CSV and JSON questions both groups opened the full data, which is what you want: the digest showed the shape and said what was missing, and nobody guessed.

Small print: synthetic fixtures, one run each, one model. It shows the mod does its job without getting in the way, not a benchmark.

## What it leaves alone

- **Read, Edit, Write**: Claude always sees files whole
- **WebFetch** and **MCP answers that aren't JSON** (documentation, prose)
- Anything under the threshold
- A command that reads a saved output (`.context-diet/…`) or carries `# diet:off`, for when you want one output uncut

## The panel

`/diet` opens a panel with the tokens saved this session and all time, the savings per tool, and the latest cuts. Open a cut to see what it kept, the path to the full output and the start of what Claude read. Under the prompt, the status line reads like `◇ diet −42k tok · 17 cuts`.

<details>
<summary><b>Screenshots</b></summary>

**What Claude reads with Context Diet**

![After](docs/img/after.png)

**What it reads without**

![Before](docs/img/before.png)

**The panel**

![Panel](docs/img/panel.png)

</details>

The pictures are rendered from the mod's real compressor and panel (`media/` has the scripts).

## Commands

| Command | What it does |
| --- | --- |
| `/diet` | Open the panel (or print a report where no panel can be shown) |
| `/diet report` | Print the report in the transcript |
| `/diet on` · `off` | Turn it on or off |
| `/diet 16k` | Cut outputs longer than this many characters (default 8000) |
| `/diet demo` · `reset` | Fill the panel with sample cuts, or clear this session's figures |

## Where the full outputs go

Each cut output is saved whole to `.context-diet/out-NNN.txt` in your project, with a one-line header. The folder carries its own `.gitignore`, so git never sees it. The names cycle through 300 slots, so the folder stops growing at 300 files. When Claude Code has already saved an output to a file, Context Diet uses that file and writes nothing.

## Privacy

Context Diet runs inside your Claude Code process and makes no network requests. It changes only what the model reads, and the full text stays on your disk. It writes nowhere but `.context-diet/` in your project, plus a counter and all-time totals in the plugin's local store.

## Requirements

- Claude Code **v2.1.287 or later** (mods are on by default). Check with `claude --version`.
- The digests work wherever Claude Code loads mods; the panel draws in the terminal and the desktop app's Code tab. The regular chat tab of the desktop app does not load mods.

## Develop

```bash
git clone https://github.com/drkokorev/context-diet
cd context-diet
claude plugin validate plugins/context-diet
claude plugin test plugins/context-diet
claude --plugin-dir plugins/context-diet
```

The compressors are pure functions in `plugins/context-diet/hooks/diet.ts`; the hooks, panel and commands are in `hooks/register.tsx`. Issues and pull requests are welcome, especially logs it digests badly.

## Roadmap

- Digests tuned per tool: cargo, go test, pytest, tsc, eslint
- Thresholds per tool in `/config`
- Clearing old saved outputs from the panel
- A shared view with [Cockpit](https://github.com/drkokorev/cockpit-for-claude): see the context hogs there, trim them here

## License

[MIT](LICENSE)
