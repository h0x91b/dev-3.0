# Dev-3.0

Terminal-centric project manager — iTerm2 meets Kanban.

A desktop app for managing multiple AI coding agents (Claude Code, Gemini CLI, etc.) and other terminal tools across tasks and projects. Each task gets its own git worktree and a terminal session with tmux, so you can run dozens of agents in parallel without losing track.

## Tech stack

- **Runtime:** [Bun](https://bun.sh)
- **Desktop framework:** [Electrobun](https://electrobun.dev) (not Electron)
- **Frontend:** React 18, Tailwind CSS, Vite
- **Terminal:** [ghostty-web](https://github.com/nichochar/ghostty-web) + native PTY via `Bun.spawn`

## Quick start

```bash
bun install
bun run dev        # Vite HMR + Electrobun
```

## Project structure

```
src/
  bun/          Main process (Bun + Electrobun APIs)
  mainview/     Renderer (React app bundled by Vite)
docs/           Local docs for dependencies
concept.md      Product concept & implementation status
AGENTS.md       Instructions for AI coding agents (CLAUDE.md is a symlink)
```

## How it works

1. You add a project (any git repo on disk).
2. You create tasks on a Kanban board.
3. Each task spins up an isolated git worktree + terminal with tmux.
4. A preconfigured command (e.g., `claude`) launches automatically inside tmux.
5. You manage all your agents and tasks from one place.

See [concept.md](concept.md) for detailed design and current status.

## Development

```bash
bun run dev        # HMR mode (Vite dev server + Electrobun concurrently)
bun run dev:once   # Build once, then run
bun run build      # Staging build
bun run build:prod # Production build
```

## License

Private.
