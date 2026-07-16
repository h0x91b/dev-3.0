<p align="center">
  <img src="docs/icon.png" width="128" height="128" alt="dev-3.0">
</p>

<h1 align="center">dev-3.0</h1>

<p align="center">
  <strong>Mission control for the One Person Studio</strong><br>
  AI writes the code now — your job is commanding the fleet. dev-3.0 is the Kanban-first cockpit for running dozens of AI coding agents at full speed, while one board keeps you focused. Each task gets its own git worktree, tmux session, and terminal.
</p>

<p align="center">
  <a href="https://github.com/h0x91b/dev-3.0/releases"><img src="https://img.shields.io/github/v/release/h0x91b/dev-3.0?style=flat-square&color=4496ff" alt="Release"></a>
  <a href="https://github.com/h0x91b/dev-3.0/stargazers"><img src="https://img.shields.io/github/stars/h0x91b/dev-3.0?style=flat-square&color=4496ff" alt="Stars"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache%202.0-4496ff?style=flat-square" alt="License"></a>
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux-4496ff?style=flat-square" alt="Platform: macOS and Linux">
</p>

<p align="center">
  <a href="https://dev3.h0x91b.com/">Website</a> ·
  <a href="https://github.com/h0x91b/dev-3.0/releases/latest">Download</a> ·
  <a href="https://github.com/h0x91b/dev-3.0/issues">Issues</a>
</p>

---

<p align="center">
  <img src="docs/screenshots/kanban-board.jpg" width="800" alt="Kanban board — tasks across To Do, Working, Review and Done columns">
</p>

## Quick start

🤖 **The fastest way** — paste this into Claude Code, Codex, Gemini CLI, whatever you already run:

```text
Install dev-3.0 by following the guide at https://dev3.h0x91b.com/ai-install.txt
```

The agent reads the guide, detects your OS, and does the whole install itself.

Or by hand — **macOS**:

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

Every option — direct DMG download, CLI tarball without Homebrew, cloud-VM caveats, build from source — in [Install](#install).

## Philosophy

AI writes the code now. It commits, opens PRs, reviews. Your job changed —
from *writing* to *commanding* a fleet of agents across more tasks and projects
than any one head can hold. The bottleneck moved: it's not your editor anymore,
it's your **focus**. Everything in dev-3.0 is built around that. Two things we
optimize for, above all:

**1. Your speed — as one person.**
dev-3.0 optimizes a single developer: *you*. The unit is always the individual,
never the org. It works fine on a team — but it's not a tool for managing other
people; it's a tool for each person to command their own fleet and hit their own
top speed. Everyone focuses on themselves, and the whole moves faster.

**2. Beautiful, and built around you.**
A cockpit you stare at all day should be fast, gorgeous, and keyboard-first — and
it should bend to *your* way of working, not force one on you. Great tooling
doesn't just make you productive; it makes the work fun again. We sweat the polish.

**And what we refuse: dev-3.0 is not an IDE — and won't become one.**

- **The code is the agent's job.** No embedded editor; one click to your real
  VS Code or Cursor when you truly need it — and the goal is to need it less.
- **Git is the agent's job too.** No manual staging, no hand-written commits.
- **Integrate through your agent.** Claude Code, Codex & co. already speak MCP to
  Linear, Jira, and the rest. dev-3.0 is the cockpit; your agent is the adapter.

## The problem

You're running 5+ AI agents across different terminals, repos, and branches. Switching context takes forever. You lose track of what's where. Merge conflicts pile up because multiple agents edit the same repo.

## The solution

dev-3.0 gives you a Kanban board where each task is a fully isolated environment:

1. **Create a task** on the board — describe what needs to be done
2. **An isolated git worktree** is created automatically — zero conflicts between parallel agents
3. **A terminal with tmux** launches inside the worktree with your configured command (e.g., `claude`)
4. **See everything at a glance** — hover over any card for a live terminal preview

<p align="center">
  <img src="docs/screenshots/terminal-view.jpg" width="800" alt="Three AI agents running in parallel — Claude Code, Codex and opencode in split panes">
</p>

## Key features

- **Kanban workflow** — drag tasks between columns (To Do → In Progress → Review → Completed)
- **Git worktree per task** — full repo isolation, no merge conflicts between parallel tasks
- **Multiple agents per task** — run several agents side by side in the same worktree via tmux split panes
- **Multi-agent launch** — pick any combination of Claude, Cursor, Codex, Gemini, opencode, or any CLI agent — each with its own config
- **Remote / browser mode** — run headless on a server and drive the full UI from any browser (even your phone) with `dev3 remote` — QR login plus an optional Cloudflare tunnel
- **Multi-project dashboard** — manage multiple projects from a single Activity view with live agent status
- **Live terminal preview** — hover any card to see what the agent is doing right now
- **Terminal bell alerts** — red badges on cards when an agent needs your attention
- **One-click dev server** — launch, restart, or stop your app from the task's worktree in a single click
- **Custom workflow columns** — define your own pipeline stages (AI Review, PR Review, On Hold, etc.)
- **Labels & search** — organize tasks with colored labels and instant full-text search
- **Dark & light themes** — full theme support for both dark and light environments
- **Automated setup** — configure a setup script per project that runs for every new task
- **Copy-on-Write clone paths** — clone `node_modules`, `.venv`, `build`, and other heavy directories into worktrees instantly with near-zero disk overhead
- **PR review mode** — check out any remote branch and toggle "PR review" to pre-fill a structured code-review prompt for the agent
- **Built-in code review** — inline diff viewer with syntax highlighting, line-range comments, and one-click export of your review back to the agent
- **Bug hunters** — launch a pack of read-only agents that hunt bugs across your branch diff in parallel
- **Command palette & quick switch** — ⌘⇧P to run any action, ⌘K to jump between projects, Option+Tab to flip between tasks with live previews

<p align="center">
  <img src="docs/screenshots/activity-dashboard.jpg" width="800" alt="Multi-project activity dashboard with live agent status">
</p>

<p align="center">
  <img src="docs/screenshots/multi-agent-launch.jpg" width="600" alt="Launch task with multiple AI agents: Claude, Cursor, Codex, Gemini">
</p>

<p align="center">
  <img src="docs/screenshots/light-theme-kanban.jpg" width="800" alt="Light theme — Kanban board with labels and tips">
</p>

<p align="center">
  <img src="docs/screenshots/global-settings.jpg" width="600" alt="Global settings — agents, configs, languages">
</p>

## Which is for you?

Other tools in this space are great — if you want to live in an editor.
dev-3.0 makes a different bet. Pick by your goal, not a feature checklist:

| If you want to… | Reach for… |
|---|---|
| Stay in an editor, hands on the code and git | an **agent IDE** |
| Buy a platform for a whole team (SSO, seats, audit) | a **team orchestrator** |
| Run a fleet of agents **solo**, at speed, without drowning | **dev-3.0** |

## Install

The two fastest paths (agent-driven and Homebrew) are in [Quick start](#quick-start) above. Everything else lives here.

### Desktop app — macOS

#### Homebrew (recommended)

```sh
brew tap h0x91b/dev3
brew trust h0x91b/dev3   # newer Homebrew refuses untrusted third-party taps (skip on older brew)
brew install --cask dev3
```

Auto-installs the required `git` and `cloudflared` dependencies (the latter powers the public-tunnel option used by `dev3 remote` and the in-app remote-access modal). tmux is bundled inside the app itself — a pinned, self-contained 3.6a build (tmux 3.7 has a client-side CPU regression; see [Troubleshooting](#troubleshooting)).

```sh
brew upgrade --cask dev3   # update
brew uninstall --cask dev3 # remove
```

#### Manual download

Grab the latest `.dmg` directly — [**Apple Silicon**](https://github.com/h0x91b/dev-3.0/releases/latest/download/stable-macos-arm64-dev-3.0.dmg) or [**Intel**](https://github.com/h0x91b/dev-3.0/releases/latest/download/stable-macos-x64-dev-3.0.dmg) — drag to Applications, and run. tmux is bundled inside the app; make sure `git` is installed, plus `cloudflared` if you want the public-tunnel feature (`brew install cloudflared`; safe to skip otherwise).

Apple Silicon and Intel are both supported. Windows is on the roadmap.

### Linux — remote work (recommended)

The fastest way to run dev-3.0 on a Linux box (cloud VM, dev server, headless host) is the `dev3` CLI over Homebrew. **Two commands, then `dev3 remote`** — it prints an access URL + QR you open from your laptop. `tmux`, `git`, and `cloudflared` come along as brew dependencies.

> ⚠️ **Don't run the Homebrew installer as `root`** — it refuses by design. On a fresh VM, create a regular user first: `useradd -m -s /bin/bash dev3 && su - dev3`. Glibc ≥ 2.28 required (Ubuntu 18.04+, Debian 10+, RHEL 8+).

**1. Install Homebrew** (one-time). Pick the line matching your shell — the only difference is which rc file gets the PATH:

<details open>
<summary><strong>bash</strong></summary>

```bash
curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh | bash && \
  echo 'eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)"' >> ~/.bashrc && \
  eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)"
```

</details>

<details>
<summary><strong>zsh</strong></summary>

```zsh
curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh | bash && \
  echo 'eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)"' >> ~/.zshrc && \
  eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)"
```

</details>

**2. Install dev-3.0** (same tap as macOS):

```sh
brew tap h0x91b/dev3 && brew trust h0x91b/dev3 && brew install h0x91b/dev3/dev3
```

**3. Go remote:**

```sh
dev3 remote
```

That's it. Full Homebrew-on-Linux docs: https://docs.brew.sh/Homebrew-on-Linux

This installs the `dev3` CLI. Three ways to use it:

- **Headless / browser UI** — `dev3 remote` prints an ASCII QR, an access URL, and an SSH-forward hint. By default it also starts a Cloudflare quick tunnel so you can connect from anywhere without SSH (`cloudflared` is installed as a brew dep). Pass `--no-tunnel` for local-only mode. The token rotates every 25 seconds; the QR auto-refreshes too. Perfect for remote dev boxes.
  - **Background lifecycle (for SSH boxes)** — `dev3 remote` backgrounds the server by default, so it survives your SSH session (add `--no-detach` to keep it in the foreground). From any later SSH session, `dev3 remote status` shows it (PID, port, uptime), `dev3 remote url` re-prints a fresh QR/URL to re-scan from your phone, `dev3 remote logs --follow` tails its output, `dev3 remote restart` relaunches it, and `dev3 remote stop` shuts it down cleanly.
  - **Run as a service** — `dev3 remote install-service --port <n>` installs a systemd --user unit so the server survives logout and restarts on boot (`dev3 remote uninstall-service` removes it). Tip: `sudo loginctl enable-linger $USER` keeps user services running while you're logged out.
  - **Trusted device** — after you scan the QR once, the browser remembers the session (8h) and reconnects on reload without rescanning.
- **Desktop GUI** — `dev3 gui` launches the full Electrobun desktop app. On the first run it lazily downloads the bundle (~88 MB) into `~/.dev3.0/gui/` and registers an XDG menu entry. If your distro is missing GTK/WebKit libraries it prints the exact `apt`/`dnf`/`pacman` command for you to copy.
- **CLI tooling** — `dev3 task …`, `dev3 current`, `dev3 note add …` etc. when you want to script the Kanban board from a terminal.

#### Pre-built CLI tarball (no Homebrew)

If you don't want Homebrew at all (e.g. running inside a minimal container), grab the CLI tarball directly:

```sh
# Auto-pick your arch: x64 (Intel/AMD, e.g. Hetzner CPX/CCX) or arm64 (Ampere/Graviton, e.g. Hetzner CAX)
case "$(uname -m)" in aarch64|arm64) A=arm64;; *) A=x64;; esac
curl -fsSL -o /tmp/dev3.tar.gz \
  "https://github.com/h0x91b/dev-3.0/releases/latest/download/dev3-cli-linux-$A.tar.gz"

mkdir -p ~/.dev3 && tar -C ~/.dev3 -xzf /tmp/dev3.tar.gz
~/.dev3/dev3 remote
# (optional) put it on PATH: echo 'export PATH=$HOME/.dev3:$PATH' >> ~/.bashrc
```

Make sure `tmux` (see [tmux on Linux](#tmux-on-linux--version-matters) — the version matters), `git`, and `cloudflared` are installed (for `cloudflared` see [Cloudflare's docs](https://github.com/cloudflare/cloudflared#installing-cloudflared)). Without `cloudflared` `dev3 remote` still works — it just falls back to LAN + SSH-forward URLs (or pass `--no-tunnel` to skip the check).

#### tmux on Linux — version matters

Unlike macOS builds (which bundle a self-contained tmux 3.6a inside the app and CLI tarball), **Linux artifacts do not ship tmux — you bring your own**. The Homebrew formula still installs the pinned `h0x91b/dev3/tmux@3.6` keg automatically; tarball installs rely on the system tmux.

The pinned, tested version is **3.6a**. Any 3.3–3.6 works; **avoid the 3.7.x line** — its client busy-spins at 100% CPU on a congested server socket and freezes the UI (the whole reason for the pin). Check what you have: `tmux -V`.

Current stable distro repos still ship pre-3.7 versions, so the stock package is fine:

```sh
sudo apt-get update && sudo apt-get install -y tmux   # Debian / Ubuntu
sudo dnf install -y tmux                              # Fedora / RHEL 9+ / Alma / Rocky
sudo yum install -y tmux                              # RHEL 8 / CentOS 8
sudo zypper install -y tmux                           # openSUSE
sudo pacman -S --noconfirm tmux                       # Arch (rolling — check `tmux -V`, may already be 3.7!)
sudo apk add tmux                                     # Alpine
```

If your distro already ships 3.7.x (rolling releases), install exactly 3.6a instead — either via Homebrew on Linux (`brew install h0x91b/dev3/tmux@3.6`; the app prefers the keg automatically) or from source:

```sh
sudo apt-get install -y build-essential libevent-dev libncurses-dev bison   # Debian/Ubuntu deps
# sudo dnf install -y gcc make libevent-devel ncurses-devel bison           # Fedora/RHEL deps
curl -fsSL https://github.com/tmux/tmux/releases/download/3.6a/tmux-3.6a.tar.gz | tar xz
cd tmux-3.6a && ./configure && make -j"$(nproc)" && sudo make install
```

`dev3 doctor` flags a 3.7.x tmux with a warning, and the app logs it at startup.

#### Caveats for cloud VMs

- **IPv4 outbound** is required — GitHub has no AAAA records, and DNS64/NAT64 on IPv6-only cloud VMs is unreliable. On Hetzner Cloud, add a Primary IPv4 (~€0.49/mo) when creating the VM.
- **2 GB VMs** work fine for the brew/tarball install (no build needed). If you ever build from source on one, add 4 GB swap first — vite OOMs on the first build:
  ```bash
  fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
  ```

#### Build from source (contributors)

```bash
apt-get install -y git tmux bash ca-certificates curl unzip
curl -fsSL https://bun.sh/install | bash && source ~/.bashrc

git clone https://github.com/h0x91b/dev-3.0.git && cd dev-3.0
bun install --frozen-lockfile
bun scripts/generate-build-info.ts
bun scripts/generate-changelog.ts
bun --bun ./node_modules/vite/bin/vite.js build   # `bun --bun` avoids Node OOM
bun build src/cli/main.ts --compile --outfile dist/dev3

./dist/dev3 remote
```

## Keyboard shortcuts

Press **⌘/** (**Ctrl+/** on Linux) inside the app — or open **Help → Keyboard Shortcuts** — to see
every shortcut in one panel (App + Terminal/tmux tabs). The full list is defined in one place,
`src/mainview/keymap.ts`.

| Action | macOS | Linux |
|---|---|---|
| Go to project (quick switch) | ⌘K | Ctrl+K |
| Command palette | ⇧⌘P | Ctrl+Shift+P |
| Keyboard shortcuts panel | ⌘/ | Ctrl+/ |
| Help mode (explain this screen) | ⇧⌘/ | Ctrl+Shift+/ |
| Terminal immersive fullscreen | F11 / ⇧⌘F | F11 / Ctrl+Shift+F |
| Back / Forward | ⌘[ / ⌘] | Ctrl+[ / Ctrl+] |
| Previous / next live variant | ⇧⌘[ / ⇧⌘] | Ctrl+Shift+[ / Ctrl+Shift+] |
| Switch to project 1–9 (keep view) | ⌘1–9 | Ctrl+1–9 |
| Switch to project 1–9 (flip view) | ⇧⌘1–9 | Ctrl+Shift+1–9 |
| Cycle active tasks (this project / all) | ⌥Tab / ⌥⇧Tab | Ctrl+Tab / Ctrl+Shift+Tab |
| New task | ⌘N | Ctrl+N |
| Add project | ⌘P | Ctrl+P |
| New window | ⇧⌘N | Ctrl+Shift+N |
| Settings | ⌘, | Ctrl+, |
| Zoom in / out / reset | ⌘= / ⌘- / ⌘0 | Ctrl+= / Ctrl+- / Ctrl+0 |
| Hard refresh | ⌘R | Ctrl+R |
| Toggle project terminal / open Quick Shell | ⌘` / ⇧⌘` | Ctrl+` / Ctrl+Shift+` |
| Close dialog / step back | Esc | Esc |
| Quit / Hide | ⌘Q / ⌘H | Ctrl+Q / Ctrl+H |

Terminal multiplexing uses tmux's `⌃B` prefix bindings — see the **Terminal (tmux)** tab in the same panel.

## Tech stack

| Component | Technology |
|---|---|
| Desktop runtime | [Electrobun](https://electrobun.dev) — native webview (WKWebView on macOS, WebKitGTK on Linux), no Chromium |
| JS runtime | [Bun](https://bun.sh) |
| Terminal | [ghostty-web](https://github.com/nichochar/ghostty-web) — GPU-accelerated rendering |
| Frontend | React 19, Tailwind CSS, Vite |
| Multiplexer | tmux |

## Development

```bash
bun install
bun run dev          # Build + launch the app locally (no HMR)
bun run build        # Staging build
bun run build:prod   # Production build
bun run lint         # TypeScript type-check
bun run test         # Run tests (fast subset; use `bun run test:full` for CI parity)
```

See [AGENTS.md](AGENTS.md) for full architecture docs and coding guidelines.
See [agent-support-matrix.md](agent-support-matrix.md) for feature compatibility across AI agents.

## Troubleshooting

### Start with `dev3 doctor`

Run this before changing files, reinstalling the app, or creating tmux symlinks:

```sh
dev3 doctor
```

It works while the app is closed and checks the app/CLI versions, the saved tmux path, the managed shim, the tmux binary (bundled / keg / PATH), and Homebrew state. Follow the commands printed under the failed check. Do not create `~/.dev3.0/bin/tmux` yourself — dev-3.0 owns and recreates that shim.

### tmux is missing or terminals do not start

macOS releases bundle a self-contained pinned tmux inside the app (`Contents/Resources/app/tmux/tmux`) and the CLI tarball, so no Homebrew or Command Line Tools are needed for it. If `dev3 doctor` reports that no usable tmux binary exists, reinstall the app (or update to the latest version); as an alternative remedy the pinned Homebrew keg still works:

```sh
brew tap h0x91b/dev3
brew trust h0x91b/dev3 2>/dev/null || true
brew install h0x91b/dev3/tmux@3.6
```

On Linux nothing is bundled — install tmux from your package manager and mind the version: see [tmux on Linux — version matters](#tmux-on-linux--version-matters).

If doctor instead reports `tmux setting` or `tmux shim`, use its reset commands; installing another tmux will not repair a poisoned saved path.

### Git network commands hang only inside dev-3.0 on macOS

If `git fetch` works in Terminal.app but hangs inside a dev-3.0 task, grant **Full Disk Access** to dev-3.0 and restart it:

1. Open **System Settings → Privacy & Security → Full Disk Access**
2. Add `dev-3.0` and enable its toggle
3. Quit and relaunch dev-3.0

<p align="center">
  <img src="docs/screenshots/full-disk-access.jpg" width="700" alt="System Settings → Privacy & Security → Full Disk Access with dev-3.0 toggled on">
</p>

### Terminal colors and recommended agent themes

dev-3.0 ships a hand-tuned 16-color ANSI palette for both the **dark** and **light** UI themes, plus a readability filter that remaps unreadable foreground/background colors emitted by agents on the fly.

Every built-in **Claude Code** `/theme` option is supported: Auto, regular Light/Dark, both colorblind-friendly variants, and both ANSI-only variants. Fixed diff colors adapt in both directions when the Claude Code theme and dev-3.0 theme use opposite polarities, so even a Light Claude theme remains readable in dark dev-3.0 and vice versa.

For the most native-looking pairing, use Auto or match the polarity:

| dev-3.0 UI | Claude Code `/theme` | Codex `[tui] theme` |
|---|---|---|
| **Dark** | Dark mode, Dark mode (colorblind-friendly), or Dark mode (ANSI colors only) | **`dracula` (recommended)** |
| **Light** | Light mode, Light mode (colorblind-friendly), or Light mode (ANSI colors only) | **`github` (recommended)** |

If you'd rather have Claude Code render entirely through dev-3.0's tuned 16-color palette, run `/theme` and pick:

- **Dark mode (ANSI colors only)** — when dev-3.0 is on the dark theme
- **Light mode (ANSI colors only)** — when dev-3.0 is on the light theme

<p align="center">
  <img src="docs/screenshots/claude-code-ansi-theme.jpg" width="640" alt="Claude Code theme picker — choose 'Dark mode (ANSI colors only)' or 'Light mode (ANSI colors only)'">
</p>

This makes Claude Code emit only the 16 base ANSI colors, which dev-3.0 resolves through its tuned palette.

**Codex** has no "ANSI colors only" mode. Set the recommended matching theme in `~/.codex/config.toml`:

```toml
[tui]
# Recommended when dev-3.0 uses the dark UI
theme = "dracula"
```

```toml
[tui]
# Recommended when dev-3.0 uses the light UI
theme = "github"
```

## Star History

[![Star History Chart](https://api.star-history.com/chart?repos=h0x91b/dev-3.0&type=date&legend=top-left&sealed_token=WnGGefyKijPrjGxSOkU0sy1POJy10qROzjxTQzjREVPRgboUHeKms8QoKfbjBhpAELRp43hLJuFfAmV8FzzqoajmuVhitbt_3JqKSxG1EJz2woJLCMrTPB-I_TYHK3f0Z3gPFlkM_nhrZe6rSBmJKso_yWZNlHbWTmZW097ch2-bCE-H5utUdU0ar_4O)](https://www.star-history.com/?repos=h0x91b%2Fdev-3.0&type=date&legend=top-left)

## License

[Apache 2.0](LICENSE) — © 2026 Arseny Pavlenko
