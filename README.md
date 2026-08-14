<p align="center">
  <img src="docs/icon.png" width="128" height="128" alt="dev-3.0">
</p>

<h1 align="center">dev-3.0</h1>

<p align="center">
  <strong>A Kanban board where every card is a live AI coding agent.</strong><br>
  Each task gets its own git worktree, its own terminal and its own agent — so a dozen of them
  can run at the same time without ever touching each other's files.
</p>

<p align="center">
  <a href="https://github.com/h0x91b/dev-3.0/releases"><img src="https://img.shields.io/github/v/release/h0x91b/dev-3.0?style=flat-square&color=4496ff" alt="Release"></a>
  <a href="https://github.com/h0x91b/dev-3.0/stargazers"><img src="https://img.shields.io/github/stars/h0x91b/dev-3.0?style=flat-square&color=4496ff" alt="Stars"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache%202.0-4496ff?style=flat-square" alt="License"></a>
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-4496ff?style=flat-square" alt="Platform: macOS, Linux and Windows">
</p>

<p align="center">
  <a href="https://dev3.h0x91b.com/">Website</a> ·
  <a href="#quick-start"><strong>Quick start</strong></a> ·
  <a href="https://github.com/h0x91b/dev-3.0/releases/latest">Download</a> ·
  <a href="#documentation">Docs</a> ·
  <a href="https://github.com/h0x91b/dev-3.0/issues">Issues</a>
</p>

<p align="center">
  <img src="docs/screenshots/kanban-board.jpg" width="900" alt="The dev-3.0 Kanban board — tasks moving across To Do, Agent is Working, Has Questions, AI Review, Your Review and PR Review">
</p>

<p align="center">
  <sub>Every card is a real git worktree, a real terminal and a real branch.</sub>
</p>

---

## What using it looks like

> **Write a task → get a worktree → an agent works in it → you watch → you review → it merges**

Six steps. You write the first one and approve the last; the middle four happen on the board.

### 1. Write a task, pick who does it

You describe the work and choose the agent. Claude Code, Codex, Gemini, Cursor Agent, opencode
— or several at once, each in its own pane of the same task.

<p align="center">
  <img src="docs/screenshots/multi-agent-launch.jpg" width="820" alt="Agent picker on a task — Claude, Codex, Gemini, Oh My OpenCode, Cursor Agent">
</p>

### 2. dev-3.0 builds the sandbox

A fresh **git worktree** off your base branch, a **tmux session** inside it, your per-project
setup script, and — if you asked for them — free ports reserved for that task's dev server.
Heavy directories like `node_modules` or `.venv` are copy-on-write cloned, so the sandbox costs
near-zero disk and appears instantly.

Nothing the agent does can collide with another task. That is the whole reason ten of them can
run at once.

### 3. Watch without opening anything

Hover a card and the live terminal comes to you. No clicking in, no losing your place on the
board.

<p align="center">
  <img src="docs/screenshots/hover-preview.gif" width="820" alt="Hovering a Kanban card shows a live preview of the agent's terminal">
</p>

The card also carries the state you actually need at a glance: which agent and model, priority,
memory use, a bell when the agent wants you, and a red badge when it asked a question.

### 4. Several agents on one task, side by side

Split panes in the same worktree — one writes, one reviews, one runs the tests. Or three
independent **variants** of the same task on separate branches when you want to see which
approach wins.

<p align="center">
  <img src="docs/screenshots/terminal-view.jpg" width="900" alt="Claude Code, OpenAI Codex and opencode running in three split panes of one task">
</p>

<p align="center">
  <img src="docs/screenshots/multi-attempt.jpg" width="900" alt="Sibling variants of one task, each on its own branch, with a popover to jump between them">
</p>

### 5. Read the diff before anyone merges it

The built-in review panel shows the whole branch diff with syntax highlighting, per-file read
state, and inline comments on any line range. When you are done, one click copies the review
back into the agent's terminal as a prompt.

<p align="center">
  <img src="docs/screenshots/code-review.jpg" width="900" alt="Built-in diff viewer with an inline comment being written on a line range">
</p>

Not sure the diff is safe? Launch a pack of **read-only bug hunters** — several agents that
comb the same branch diff in parallel, each seeded to look somewhere different, and report only
what they can prove.

<p align="center">
  <img src="docs/screenshots/bug-hunters.jpg" width="820" alt="Spawn bug hunters dialog — choose how many hunters, which agent and which config">
</p>

### 6. Ship

The agent opens the PR and enables auto-merge. The card then shows the PR number and live CI
state, so a red build finds you instead of you going looking for it.

<p align="center">
  <img src="docs/screenshots/pr-ci-review-badges/card-closeup.png" width="360" alt="Task card showing a PR number badge and a green CI badge">
</p>

---

## What else is in there

### Your whole day on one screen

Every project, every running agent, one Activity view.

<p align="center">
  <img src="docs/screenshots/activity-dashboard.jpg" width="900" alt="Multi-project activity dashboard with live agent status per project">
</p>

One click away: what the fleet actually got done. Tasks shipped, lines changed, velocity,
completion rate, active-day streak and average task lifetime — each against last week.

<p align="center">
  <img src="docs/screenshots/productivity-stats.jpg" width="900" alt="Productivity screen — six gauges plus tasks-completed and lines-changed charts">
</p>

### The board is yours to shape

Add your own columns — *AI Review*, *PR Review*, *On Hold*, whatever your pipeline actually is —
and attach an agent to a column so that dropping a card there **starts** the work. Drag a task
into *AI Review* and a reviewer agent spins up on its own.

### It runs headless, and your phone is a client

```sh
dev3 remote
```

Serves the full UI to any browser over a Cloudflare tunnel, your LAN, or an SSH forward. Scan
the QR once and your phone stays connected for 8 hours. Same board, same terminals, same live
previews — on a dev box you never sit in front of.

<p align="center">
  <img src="docs/screenshots/remote-access.jpg" width="820" alt="Remote Access modal with a QR code and the LAN, tunnel and SSH-forward URLs">
</p>

### Keyboard-first, because you switch tasks all day

⌘K jumps between projects, ⇧⌘P runs any action, ⌥Tab cycles live tasks with a preview of each.

<p align="center">
  <img src="docs/screenshots/command-palette.jpg" width="820" alt="Command palette open over the board">
</p>

### A CLI the agents themselves use

`dev3` is not a side door — it is how agents talk back to the board. They set the task overview,
leave notes for whoever picks the task up next, ping you when blocked, show you an image or an
interactive HTML report, start a peer task, or peek at another task's terminal without
disturbing it.

```sh
dev3 attention "Need a decision on the schema"    # red badge on the card
dev3 show-image before.png --caption "the bug"    # in-app image viewer
dev3 peek --task seq:1383                         # read-only look at a peer's terminal
dev3 message --task seq:1383 --in 30m "status?"   # type into a live agent, now or later
dev3 doctor --worktrees --prune-orphans           # reclaim disk from dead worktrees
```

### An agent can hand you a document instead of scrollback

`dev3 show-artifact report.html` puts a self-contained interactive page into the task — charts,
filters, sortable tables, its own light/dark switch. It opens beside the terminal that produced
it, stays attached to the task, and downloads as a ZIP. No server, no upload, nothing external.

<p align="center">
  <img src="docs/screenshots/artifact-viewer.jpg" width="900" alt="An agent-authored interactive report open in the artifact panel, beside the terminal that wrote it">
</p>

### And the small things

Dark and light themes · a hand-tuned 16-color ANSI palette so agents look right in both ·
English / Russian / Spanish · one-click dev server per task with auto-assigned ports · labels
and full-text search · sparse checkout for monorepos · scheduled and recurring agent runs ·
drag-and-drop files and pasted screenshots straight into a prompt · multi-window, one per
monitor.

<p align="center">
  <img src="docs/screenshots/light-theme-kanban.jpg" width="900" alt="The same board in the light theme">
</p>

---

## Why it works this way

AI writes the code now. It commits, opens PRs, reviews. Your job changed — from *writing* to
*commanding* a fleet of agents across more tasks and projects than any one head can hold. The
bottleneck moved: it's not your editor anymore, it's your **focus**. Everything above is built
around that. Two things we optimize for, above all:

**1. Your speed — as one person.**
dev-3.0 optimizes a single developer: *you*. The unit is always the individual, never the org.
It works fine on a team — but it's not a tool for managing other people; it's a tool for each
person to command their own fleet and hit their own top speed. Everyone focuses on themselves,
and the whole moves faster.

**2. Beautiful, and built around you.**
A cockpit you stare at all day should be fast, gorgeous, and keyboard-first — and it should bend
to *your* way of working, not force one on you. Great tooling doesn't just make you productive;
it makes the work fun again. We sweat the polish.

**And what we refuse: dev-3.0 is not an IDE — and won't become one.**

- **The code is the agent's job.** No embedded editor; one click to your real VS Code or Cursor
  when you truly need it — and the goal is to need it less.
- **Git is the agent's job too.** No manual staging, no hand-written commits.
- **Integrate through your agent.** Claude Code, Codex & co. already speak MCP to Linear, Jira,
  and the rest. dev-3.0 is the cockpit; your agent is the adapter.

### Which is for you?

Other tools in this space are great — if you want to live in an editor. dev-3.0 makes a
different bet. Pick by your goal, not a feature checklist:

| If you want to… | Reach for… |
|---|---|
| Stay in an editor, hands on the code and git | an **agent IDE** |
| Buy a platform for a whole team (SSO, seats, audit) | a **team orchestrator** |
| Run a fleet of agents **solo**, at speed, without drowning | **dev-3.0** |

### What that buys you, concretely

| Situation | What dev-3.0 does about it |
|---|---|
| Five agents editing the same repo | Five worktrees. They physically cannot conflict |
| You have no idea which of three approaches is best | Run all three as variants of one task, compare the diffs, keep one |
| An agent stops and waits for you — and you don't notice | The card turns red and the bell rings; **Has Questions** is a column |
| Reviewing agent output in a terminal is miserable | Full diff viewer with inline comments, and the review goes back as a prompt |
| You left the laptop and the build is still running | `dev3 remote`, scan the QR, keep going from your phone |
| A long task finished hours ago and you forgot it existed | The card carries the agent-written overview and notes, not just a title |
| Three hundred old worktrees ate your SSD | `dev3 doctor --worktrees` shows exactly what is reclaimable, and only deletes on your say-so |

---

## Quick start

🤖 **The fastest way** — paste this into Claude Code, Codex, Gemini CLI, whatever you already
run:

```text
Install dev-3.0 by following the guide at https://dev3.h0x91b.com/ai-install.txt
```

The agent reads the guide, detects your OS, and does the whole install itself.

**macOS**, by hand:

```sh
brew tap h0x91b/dev3
brew trust h0x91b/dev3   # newer Homebrew refuses untrusted third-party taps (skip on older brew)
brew install --cask dev3
```

**Linux** (headless box, full UI in your browser):

```sh
brew tap h0x91b/dev3 && brew trust h0x91b/dev3 && brew install h0x91b/dev3/dev3
dev3 remote
```

**Windows** — download
[`canary-win-x64-dev-3.0-canary.zip`](https://github.com/h0x91b/dev-3.0/releases/download/canary/canary-win-x64-dev-3.0-canary.zip)
(~121 MB), extract it, run `bin\launcher.exe`. Windows support is brand new and may still be
rough: the build ships in the canary channel only — the stable download page has no Windows
file yet — and it is unsigned, so the first launch needs two clicks past a SmartScreen warning.
Details: **[Install guide](docs/install.md#windows--canary-zip)**.

Then: add a project (point it at a git repo), press **⌘N**, describe a task, pick an agent, hit
Run. That is the whole onboarding.

> Prefer a direct `.dmg`, a CLI tarball without Homebrew, a systemd service, or a build from
> source? → **[Install guide](docs/install.md)**

## Agents and platforms

| | Runs today |
|---|---|
| **Agents** | Claude Code · Codex · Gemini CLI · Cursor Agent · opencode · any CLI tool you configure |
| **Desktop** | macOS — Apple Silicon and Intel. Windows x64 — brand new and may still be rough; published in the canary channel only, unsigned |
| **Headless** | Linux x64 and arm64 (`dev3` CLI + browser UI) |

Claude Code and Codex additionally report their status back automatically through hooks; the
others do it through the installed dev3 skill. Session resume, system-prompt injection,
rate-limit tracking and skill directories differ per agent — the full grid is in
**[agent-support-matrix.md](agent-support-matrix.md)**.

## Documentation

| | |
|---|---|
| [Install guide](docs/install.md) | Every install path, tmux versions on Linux, cloud-VM caveats, build from source |
| [Remote access](docs/remote-access.md) | `dev3 remote` in depth — tunnels, systemd, sessions, exposed ports |
| [Troubleshooting](docs/troubleshooting.md) | `dev3 doctor`, disk reclamation, Full Disk Access, terminal colors and agent themes |
| [Keyboard shortcuts](docs/keyboard-shortcuts.md) | The complete list, mirroring the in-app ⌘/ panel |
| [Agent support matrix](agent-support-matrix.md) | What each agent supports, feature by feature |
| [CLI exit codes](docs/cli-exit-codes.md) | The `dev3` exit-code contract, for scripting |
| [Diagnostic logs](docs/diagnostic-logs.md) | What is logged locally, for how long, and what is redacted |
| [AGENTS.md](AGENTS.md) | Architecture and contributor guide |

## Development

```bash
bun install
bun run dev          # Build + launch the app locally (no HMR)
bun run build        # Staging build
bun run build:prod   # Production build
bun run lint         # TypeScript type-check
bun run test         # Tests (fast subset; `bun run test:full` for CI parity)
```

Built on [Electrobun](https://electrobun.dev) (native webview, no Chromium) and
[Bun](https://bun.sh), with React 19 + Tailwind in front, [ghostty-web](https://github.com/nichochar/ghostty-web)
for GPU-accelerated terminals, and tmux underneath.

Contributions welcome — read [AGENTS.md](AGENTS.md) first; it is the architecture doc and the
house rules in one file.

## Star history

[![Star History Chart](https://api.star-history.com/chart?repos=h0x91b/dev-3.0&type=date&legend=top-left&sealed_token=WnGGefyKijPrjGxSOkU0sy1POJy10qROzjxTQzjREVPRgboUHeKms8QoKfbjBhpAELRp43hLJuFfAmV8FzzqoajmuVhitbt_3JqKSxG1EJz2woJLCMrTPB-I_TYHK3f0Z3gPFlkM_nhrZe6rSBmJKso_yWZNlHbWTmZW097ch2-bCE-H5utUdU0ar_4O)](https://www.star-history.com/?repos=h0x91b%2Fdev-3.0&type=date&legend=top-left)

## License

[Apache 2.0](LICENSE) — © 2026 Arseny Pavlenko
