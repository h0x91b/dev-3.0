# AGENTS.md

This file provides guidance to AI coding agents when working with code in this repository.

> **Note:** `CLAUDE.md` is a symbolic link to this file (`AGENTS.md`). This is intentional — it ensures all agents (Claude Code, Cursor, Codex, etc.) read the same instructions regardless of which filename convention they follow. If you see both files changed in a diff, that's expected.

## Multi-agent workflow

Multiple AI agents may work on this project in parallel. Each agent MUST:

- **Commit immediately after making changes.** Do not wait for the user to ask — commit as soon as a logical unit of work is done. This prevents conflicts between parallel agents.
- **Only commit its own changes.** Never stage or commit files modified by another agent.
- **Always commit `.claude/` directory changes.** The `.claude/` directory (e.g., `settings.local.json`) is modified automatically during agent sessions via UI interactions. These changes are part of your session — always include them in your commits.
- **Ignore unrelated changes.** If `git status` shows modifications you didn't make (outside of `.claude/`), leave them alone. You may inform the user: "I see other uncommitted changes, but they aren't mine."
- **Never revert or discard other agents' work.** Do not run `git checkout`, `git restore`, or `git clean` on files you didn't touch. This rule has no exceptions.

## What is this

Desktop application built with **Electrobun** (not Electron), React 18, Tailwind CSS, and Vite. Runtime is Bun.

## Commands

```bash
# Development (build once, then run)
bun run dev

# Development with hot module replacement (Vite dev server + Electrobun concurrently)
bun run dev:hmr

# Build (staging channel)
bun run build

# Build (production channel)
bun run build:prod
```

No testing framework or linter is configured.

## Architecture

Two-process model:

- **Main process** (`src/bun/index.ts`): Runs in Bun via Electrobun APIs (`BrowserWindow`, `Updater`, `Utils`). Creates the app window and handles lifecycle.
- **Renderer process** (`src/mainview/`): React app bundled by Vite. Entry point is `main.tsx`, root component is `App.tsx`.

### HMR mechanism

The main process checks if the Vite dev server is running on `localhost:5173`. If the app is on the `dev` channel and the server responds, it loads from Vite (HMR enabled). Otherwise it falls back to bundled assets via the `views://` protocol.

### Build pipeline

Vite builds `src/mainview/` → `dist/`. Electrobun copies `dist/` contents into `views/mainview/` for packaging. Config in `electrobun.config.ts`.

## Key config files

- `electrobun.config.ts` — Electrobun app config (name, identifier, build copy rules)
- `vite.config.ts` — Vite config (root: `src/mainview`, output: `dist/`)
- `tailwind.config.js` — Tailwind scans `src/mainview/**/*.{html,js,ts,jsx,tsx}`
- `tsconfig.json` — Strict mode, ES2020 target, bundler module resolution
