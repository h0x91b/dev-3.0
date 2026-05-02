<p align="center">
  <img src="docs/icon.png" width="128" height="128" alt="dev-3.0">
</p>

<h1 align="center">dev-3.0</h1>

<p align="center">
  <strong>Terminal-centric project manager for AI coding agents</strong><br>
  Kanban board meets terminal. Each task gets its own git worktree, tmux session, and full terminal.
</p>

<p align="center">
  <a href="https://github.com/h0x91b/dev-3.0/releases"><img src="https://img.shields.io/github/v/release/h0x91b/dev-3.0?style=flat-square&color=4496ff" alt="Release"></a>
  <a href="https://github.com/h0x91b/dev-3.0/stargazers"><img src="https://img.shields.io/github/stars/h0x91b/dev-3.0?style=flat-square&color=4496ff" alt="Stars"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache%202.0-4496ff?style=flat-square" alt="License"></a>
  <img src="https://visitor-badge.laobi.icu/badge?page_id=h0x91b.dev-3.0" alt="visitors">
</p>

<p align="center">
  <a href="https://h0x91b.github.io/dev-3.0/">Website</a> ·
  <a href="https://github.com/h0x91b/dev-3.0/releases">Download</a> ·
  <a href="https://github.com/h0x91b/dev-3.0/issues">Issues</a>
</p>

---

<p align="center">
  <img src="docs/screenshots/kanban-hover-preview.jpg" width="800" alt="Kanban board with live terminal preview">
</p>

## The problem

You're running 5+ AI agents across different terminals, repos, and branches. Switching context takes forever. You lose track of what's where. Merge conflicts pile up because multiple agents edit the same repo.

## The solution

dev-3.0 gives you a Kanban board where each task is a fully isolated environment:

1. **Create a task** on the board — describe what needs to be done
2. **An isolated git worktree** is created automatically — zero conflicts between parallel agents
3. **A terminal with tmux** launches inside the worktree with your configured command (e.g., `claude`)
4. **See everything at a glance** — hover over any card for a live terminal preview

<p align="center">
  <img src="docs/screenshots/terminal-view.jpg" width="800" alt="Four AI agents running in parallel — Claude, Gemini, Codex in split panes">
</p>

## Key features

- **Kanban workflow** — drag tasks between columns (To Do → In Progress → Review → Completed)
- **Git worktree per task** — full repo isolation, no merge conflicts between parallel tasks
- **Multiple agents per task** — run several agents side by side in the same worktree via tmux split panes
- **Multi-agent launch** — pick any combination of Claude, Cursor, Codex, Gemini, Aider, or any CLI agent — each with its own config
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

<p align="center">
  <img src="docs/screenshots/pr-review-mode.jpg" width="600" alt="PR review mode — pre-filled code review prompt">
</p>

## Install

### Desktop app — macOS

#### Homebrew (recommended)

```sh
brew tap h0x91b/dev3
brew install --cask dev3
```

Auto-installs the required `git` and `tmux` dependencies.

```sh
brew upgrade --cask dev3   # update
brew uninstall --cask dev3 # remove
```

#### Manual download

Download the latest `.dmg` from [**Releases**](https://github.com/h0x91b/dev-3.0/releases), drag to Applications, and run. Make sure `git` and `tmux` are installed.

Apple Silicon and Intel are both supported. Windows is on the roadmap.

### Linux server — headless mode (`dev3 remote`)

Run dev-3.0 on any Linux x86_64 box and serve the full React UI to your laptop's browser over HTTP + WebSocket. Same Kanban + terminal experience as the desktop app, no GUI on the server.

#### Requirements

- Linux x86_64 (Ubuntu 22.04+, Debian 12+ tested)
- ≥4 GB RAM, **or** 2 GB + 4 GB swap — `vite build` is memory-hungry on first build
- Outbound IPv4 — GitHub has no AAAA records, and DNS64/NAT64 on IPv6-only cloud VMs is unreliable. On Hetzner Cloud, add a Primary IPv4 (~€0.49/mo) when creating the VM.
- System tools: `git`, `tmux`, `bash`, `curl`, `unzip`, `ca-certificates`

#### Steps (Debian / Ubuntu)

```bash
# 1. System dependencies (most are pre-installed on Hetzner cloud images;
#    `unzip` is the only one usually missing, and Bun's installer needs it)
apt-get update
apt-get install -y git tmux bash ca-certificates curl unzip

# 2. (Only on 2 GB VMs) Add 4 GB swap so `vite build` doesn't OOM
fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab

# 3. Install Bun (the JS runtime dev-3.0 is built on)
curl -fsSL https://bun.sh/install | bash
source ~/.bashrc   # or open a new shell

# 4. Clone, install JS deps, build the UI + CLI + headless server
git clone https://github.com/h0x91b/dev-3.0.git /opt/dev-3.0
cd /opt/dev-3.0
bun install --frozen-lockfile
bun scripts/generate-build-info.ts
bun scripts/generate-changelog.ts
bun --bun ./node_modules/vite/bin/vite.js build
bun build src/cli/main.ts              --compile --outfile dist/dev3
bun build src/bun/headless-bootstrap.ts --compile --outfile dist/dev3-server

# 5. Run
./dist/dev3 remote --port 3000 --static-code=PICK-A-CODE
```

The server prints an ASCII QR code, an access URL, an SSH-forward hint, and (with `--tunnel`) a Cloudflare tunnel URL.

> Why `bun --bun ./node_modules/vite/bin/vite.js build` instead of plain `vite build`? On systems where `node` is also installed, the `vite` shebang routes the build through Node, which OOMs on 2 GB VMs. Forcing Bun keeps everything on one runtime.

#### Connecting from your laptop

```bash
# Option A — SSH port-forward (recommended, no public exposure)
ssh -L 3000:localhost:3000 user@<server>
# Then open http://localhost:3000/?token=PICK-A-CODE in your browser.

# Option B — Direct over public IP (open the firewall first)
# Open http://<server-ip>:3000/?token=PICK-A-CODE

# Option C — Cloudflare quick tunnel (no static IP needed)
# Install cloudflared from https://pkg.cloudflare.com, then re-run with --tunnel:
./dist/dev3 remote --port 3000 --tunnel
```

#### Optional: GitHub CLI for PR / merge detection

`gh` enables automatic PR detection, "promote to PR Review" task transitions, and merge detection. dev-3.0 runs fine without it; install it when you want those features:

```bash
type -p gh || (apt-get install -y --no-install-recommends gnupg && \
  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | \
    dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg && \
  echo "deb [signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    > /etc/apt/sources.list.d/github-cli.list && \
  apt-get update && apt-get install -y gh)
gh auth login
```

#### Optional: run as a systemd service

```ini
# /etc/systemd/system/dev3-remote.service
[Unit]
Description=dev-3.0 headless server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/dev-3.0
ExecStart=/opt/dev-3.0/dist/dev3 remote --port 3000 --static-code=PICK-A-CODE
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload
systemctl enable --now dev3-remote
journalctl -u dev3-remote -f
```

> **Pre-built Linux binaries via `brew install h0x91b/dev3/dev3` are coming.** For now, the build-from-source path above is the supported route on Linux.

## Tech stack

| Component | Technology |
|---|---|
| Desktop runtime | [Electrobun](https://electrobun.dev) — native macOS webview, no Chromium |
| JS runtime | [Bun](https://bun.sh) |
| Terminal | [ghostty-web](https://github.com/nichochar/ghostty-web) — GPU-accelerated rendering |
| Frontend | React 18, Tailwind CSS, Vite |
| Multiplexer | tmux |

## Development

```bash
bun install
bun run dev          # HMR mode (Vite dev server + Electrobun)
bun run build        # Staging build
bun run build:prod   # Production build
bun run lint         # TypeScript type-check
bun run test         # Run tests
```

See [AGENTS.md](AGENTS.md) for full architecture docs and coding guidelines.
See [agent-support-matrix.md](agent-support-matrix.md) for feature compatibility across AI agents.

## Troubleshooting

### Git errors inside worktrees (`fatal: not a git repository`)

dev-3.0 runs `git` and `tmux` as child processes. On macOS, the system may block file access for these processes even if the app itself has folder permissions. Symptoms:

- `git status` fails with `fatal: not a git repository: .../.git/worktrees/...`
- Commands work in a regular terminal but fail inside dev-3.0 task terminals

**Fix:** Grant **Full Disk Access** to the dev-3.0 app:

1. Open **System Settings → Privacy & Security → Full Disk Access**
2. Click **+** and add `dev-3.0` (from `/Applications` or your build directory)
3. Restart dev-3.0

This is needed because macOS evaluates file access per-binary — `tmux` and `git` spawned by the app don't inherit the app's folder permissions. Full Disk Access covers the app and all its child processes.

## Star History

[![Star History Chart](https://api.star-history.com/image?repos=h0x91b/dev-3.0&type=timeline&legend=top-left)](https://www.star-history.com/?repos=h0x91b%2Fdev-3.0&type=timeline&logscale=&legend=top-left)

## License

[Apache 2.0](LICENSE) — © 2026 Arseny Pavlenko

