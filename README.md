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
</p>

<p align="center">
  <a href="https://h0x91b.github.io/dev-3.0/">Website</a> ·
  <a href="https://github.com/h0x91b/dev-3.0/releases">Download</a> ·
  <a href="https://github.com/h0x91b/dev-3.0/issues">Issues</a>
</p>

---

<p align="center">
  <img src="docs/screenshots/kanban-board.png" width="800" alt="Kanban board with AI agents">
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
  <img src="docs/screenshots/hover-preview.png" width="600" alt="Live terminal preview on hover">
</p>

## Key features

- **Kanban workflow** — drag tasks between columns (To Do → In Progress → Review → Completed)
- **Git worktree per task** — full repo isolation, no merge conflicts between parallel agents
- **Live terminal preview** — hover any card to see what the agent is doing right now
- **Terminal bell alerts** — red badges on cards when an agent needs your attention
- **Multi-agent attempts** — run the same task with different agents/configs and compare results
- **Automated setup** — configure a setup script per project that runs for every new task
- **Copy-on-Write clone paths** — clone `node_modules`, `.venv`, `build`, and other heavy directories into worktrees instantly using APFS `clonefile(2)` on macOS or `--reflink` on Linux — near-zero disk overhead. Auto-detect scans your project for well-known paths across 12+ language ecosystems
- **Works with any CLI agent** — Claude Code, Codex, Gemini CLI, Aider, or any terminal tool

<p align="center">
  <img src="docs/screenshots/terminal-view.png" width="800" alt="Terminal with Claude Code and tmux">
</p>

<p align="center">
  <img src="docs/screenshots/cow-clone-paths.jpg" width="600" alt="Copy-on-Write clone paths in Project Settings">
</p>

## Install

### Homebrew (recommended)

```sh
brew tap h0x91b/dev3
brew install --cask dev3
```

This will also install required dependencies (`git`, `tmux`) if not already present.

```sh
# Update to latest version
brew upgrade --cask dev3

# Uninstall
brew uninstall --cask dev3
```

### Manual download

Download the latest `.dmg` from [**Releases**](https://github.com/h0x91b/dev-3.0/releases), drag to Applications, and run. Make sure `git` and `tmux` are installed.

macOS (Apple Silicon + Intel) and Linux — Windows coming soon.

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

## Star History

[![Star History Chart](https://api.star-history.com/image?repos=h0x91b/dev-3.0&type=timeline&legend=top-left)](https://www.star-history.com/?repos=h0x91b%2Fdev-3.0&type=timeline&logscale=&legend=top-left)

## License

[Apache 2.0](LICENSE) — © 2026 Arseny Pavlenko
