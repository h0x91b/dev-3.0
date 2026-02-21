# AGENTS.md

This file provides guidance to AI coding agents when working with code in this repository.

> **Note:** `CLAUDE.md` is a symbolic link to this file (`AGENTS.md`). This is intentional — it ensures all agents (Claude Code, Cursor, Codex, etc.) read the same instructions regardless of which filename convention they follow. If you see both files changed in a diff, that's expected.

## Multi-agent workflow

Multiple AI agents may work on this project in parallel. Each agent MUST:

- **Commit and push immediately after making changes.** Do not wait for the user to ask — commit and `git push` as soon as a logical unit of work is done. This prevents conflicts between parallel agents. This project is a solo workspace with no CI workers triggered by pushes, so pushing is always safe.
- **Only commit its own changes.** Never stage or commit files modified by another agent.
- **Always commit `.claude/` directory changes.** The `.claude/` directory (e.g., `settings.local.json`) is modified automatically during agent sessions via UI interactions. These changes are part of your session — always include them in your commits.
- **Ignore unrelated changes.** If `git status` shows modifications you didn't make (outside of `.claude/`), leave them alone. You may inform the user: "I see other uncommitted changes, but they aren't mine."
- **Never revert or discard other agents' work.** Do not run `git checkout`, `git restore`, or `git clean` on files you didn't touch. This rule has no exceptions.

## Git worktree

Agents in this project typically run inside a **git worktree**, not the main working tree. The main project lives at:

```
/Users/arsenyp/Desktop/src-shared/dev-3.0
```

If you are in a worktree, your working directory will be different (e.g., a temp path). You can always check with `git worktree list`. When you need to reference the original project (e.g., to read a secret, copy a config, or inspect the main branch state), use the path above. Never write to the main working tree from a worktree — only read.

## Changelog policy

**For every code change, create a changelog entry file.** This avoids merge conflicts when multiple agents work in parallel.

**Path:** `change-logs/YYYY/MM/DD/<type>-<short-slug>.md`

**Type prefixes:** `feature-`, `fix-`, `refactor-`, `docs-`, `chore-`

**Content:** Plain text, 1-3 sentences describing what was done. No frontmatter, no headers.

**Rules:**
- Include the changelog file in the same commit as the code change.
- The slug must be unique and descriptive enough to avoid collisions between parallel agents.
- See `change-logs/README.md` for the full format specification.

## What is this

Desktop application built with **Electrobun** (not Electron), React 18, Tailwind CSS, and Vite. Runtime is Bun.

## Commands

```bash
# Development with HMR (Vite dev server + Electrobun concurrently)
bun run dev

# Development without HMR (build once, then run)
bun run dev:once

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

## Documentation

Local documentation for key dependencies lives in `docs/`:

| Directory | What's inside | How to use |
|---|---|---|
| `docs/electrobun/` | Local markdown docs (APIs, guides) | Read files directly |
| `docs/ghostty-web/` | Local markdown docs (API, guides) | Read files directly |
| `docs/bun/` | Pointer to Bun's `llms.txt` | Fetch `https://bun.com/docs/llms-full.txt` for full docs in one request, or see `docs/bun/README.md` for all links |

**Before writing code that touches a dependency, check `docs/` first.** Read the relevant local docs or fetch remote ones as instructed. Do not guess APIs from memory — verify against the docs.

## Key config files

- `electrobun.config.ts` — Electrobun app config (name, identifier, build copy rules)
- `vite.config.ts` — Vite config (root: `src/mainview`, output: `dist/`)
- `tailwind.config.js` — Tailwind scans `src/mainview/**/*.{html,js,ts,jsx,tsx}`
- `tsconfig.json` — Strict mode, ES2020 target, bundler module resolution
