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

### Branch naming

Worktree branches are auto-generated with opaque names like `dev3/task-8711d3e1`. Once you understand what the user is actually working on, **ask them** if they'd like to rename the branch to something descriptive (e.g., `dev3/fix-login-race-condition`). Do not rename silently — always confirm first. Example prompt: "Хочешь, переименую ветку в `dev3/<suggested-name>`? Сейчас она называется `dev3/task-...`, не очень информативно." If the user agrees, run `git branch -m <old> <new>` (and update the remote if already pushed).

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

A **terminal-centric project manager** — iTerm2 meets Kanban. Desktop app for managing multiple AI coding agents and terminal-based tools across tasks and projects. Built with **Electrobun** (not Electron), React 18, Tailwind CSS, and Vite. Runtime is Bun. Cross-platform (macOS, Linux, Windows).

Key idea: each project is a git repo, each task gets its own **git worktree** + **terminal** running inside **tmux** with a preconfigured command (e.g., `claude`).

**Full product concept, design details, and implementation status tracker:** see [`concept.md`](concept.md).

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

## Styling & design tokens

All colors in the UI are defined as **CSS custom properties** (design tokens) in `src/mainview/index.css` and mapped to Tailwind via `tailwind.config.js`. Two themes exist: `dark` (default) and `light` (via `[data-theme="light"]` on `<html>`).

**Strict rule: NEVER use hardcoded hex/rgb color values in components.** Always use the semantic Tailwind token classes:

| Token class | Purpose |
|---|---|
| `bg-base`, `bg-raised`, `bg-elevated`, `bg-overlay` | Surface levels (page → panel → card → popup) |
| `bg-raised-hover`, `bg-elevated-hover` | Hover states for corresponding surfaces |
| `text-fg`, `text-fg-2`, `text-fg-3`, `text-fg-muted` | Text hierarchy (primary → muted) |
| `border-edge`, `border-edge-active` | Borders (default / hover) |
| `bg-accent`, `bg-accent-hover`, `text-accent` | Accent color (blue) |
| `text-danger`, `bg-danger` | Destructive actions (red) |

All tokens support Tailwind opacity modifiers (e.g., `bg-accent/20`, `border-accent/30`).

**Exception:** `STATUS_COLORS` in `src/shared/types.ts` are hex values used in inline styles for status-specific coloring (column headers, card borders, dots). These are semantic status colors, not theme chrome — they stay as hex.

If you need a new color, **add a CSS variable** in `index.css` (both themes) + a Tailwind mapping in `tailwind.config.js`. Do not inline arbitrary color values.

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
