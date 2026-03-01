# AGENTS.md

This file provides guidance to AI coding agents when working with code in this repository.

> **Note:** `CLAUDE.md` is a symbolic link to this file (`AGENTS.md`). This is intentional — it ensures all agents (Claude Code, Cursor, Codex, etc.) read the same instructions regardless of which filename convention they follow. If you see both files changed in a diff, that's expected.

## Language policy

**All code-related content MUST be in English — no exceptions.**

This applies to:
- Commit messages
- Changelog files (`change-logs/`)
- Code comments and docstrings
- Decision records (`decisions/`)
- PR titles and descriptions
- Any text written inside source files

The user may communicate with agents in Russian, but everything written into the codebase or git history must be in English only.

## Multi-agent workflow

Multiple AI agents may work on this project in parallel. Each agent MUST:

- **Commit and push immediately after making changes.** Do not wait for the user to ask — commit and `git push` as soon as a logical unit of work is done. This prevents conflicts between parallel agents. This project is a solo workspace with no CI workers triggered by pushes, so pushing is always safe.
- **Only commit its own changes.** Never stage or commit files modified by another agent.
- **Always commit `.claude/` directory changes.** The `.claude/` directory (e.g., `settings.local.json`) is modified automatically during agent sessions via UI interactions. These changes are part of your session — always include them in your commits.
- **Ignore unrelated changes.** If `git status` shows modifications you didn't make (outside of `.claude/`), leave them alone. You may inform the user: "I see other uncommitted changes, but they aren't mine."
- **Never revert or discard other agents' work.** Do not run `git checkout`, `git restore`, or `git clean` on files you didn't touch. This rule has no exceptions.

## GitHub CLI (`gh`)

The repo is owned by the **`h0x91b`** personal account. The developer machine has two `gh` accounts configured (`h0x91b` and `h0x91b-wix`). Before running any `gh` commands that access this repo, **switch to the correct account**:

```bash
unset GH_TOKEN && gh auth switch --user h0x91b
```

Always prefix `gh` calls with `unset GH_TOKEN &&` to avoid token conflicts (see global CLAUDE.md).

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

**Content:** Plain text, 1-3 sentences describing what was done. No frontmatter, no headers. **Keep it short — one paragraph max.**

**Rules:**
- Include the changelog file in the same commit as the code change.
- The slug must be unique and descriptive enough to avoid collisions between parallel agents.
- See `change-logs/README.md` for the full format specification.

## Decision records

Non-obvious architectural decisions, hacks, and workarounds are documented in `decisions/`. This helps future agents (and humans) understand **why** something was done a certain way — not just what.

**When to create a decision record:**
- You relied on undocumented behavior or reverse-engineered internals
- You chose a non-obvious approach over a simpler alternative for a specific reason
- You implemented a workaround for a bug or limitation in a dependency
- The decision involves trade-offs or known risks worth documenting

**Path:** `decisions/NNN-short-slug.md`

**Naming:** Sequential numbering (`001`, `002`, …). Check existing files to find the next number. Slug should be descriptive (e.g., `claude-trust-auto-register`, `worktree-branch-cleanup`).

**Required sections:**
1. **Context** — what problem you were solving
2. **Investigation** (if applicable) — what you tried, what you found
3. **Decision** — what you did and where in the code
4. **Risks** — what could break, what assumptions you made
5. **Alternatives considered** — what you rejected and why

**Rules:**
- Include the decision file in the same commit as the code change.
- **Keep it short.** Each section should be 2-4 sentences max. This is a quick reference, not a blog post. A good decision record fits on one screen.
- Link to relevant code paths (file + function names) so readers can find the implementation.

## What is this

A **terminal-centric project manager** — iTerm2 meets Kanban. Desktop app for managing multiple AI coding agents and terminal-based tools across tasks and projects. Built with **Electrobun** (not Electron), React 18, Tailwind CSS, and Vite. Runtime is Bun. Cross-platform (macOS, Linux, Windows).

Key idea: each project is a git repo, each task gets its own **git worktree** + **terminal** running inside **tmux** with a preconfigured command (e.g., `claude`).

**Full product concept, design details, and implementation status tracker:** see [`concept.md`](concept.md).

## Project scripts

Each project has three lifecycle scripts, configurable in Project Settings (`src/mainview/components/ProjectSettings.tsx`). They are stored in `projects.json` as fields on the `Project` type (`src/shared/types.ts`).

| Field | When it runs |
|---|---|
| `setupScript` | After a new worktree is created for a task |
| `devScript` | When starting the dev server for the project (not yet wired up — reserved for future use) |
| `cleanupScript` | When a task is moved to `cancelled` status (and `archived` once that status is added) |

All three are free-form shell scripts. They are saved via the `updateProjectSettings` RPC handler in `src/bun/rpc-handlers.ts`.

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

No linter is configured.

## Architecture

Two-process model:

- **Main process** (`src/bun/index.ts`): Runs in Bun via Electrobun APIs (`BrowserWindow`, `Updater`, `Utils`). Creates the app window and handles lifecycle.
- **Renderer process** (`src/mainview/`): React app bundled by Vite. Entry point is `main.tsx`, root component is `App.tsx`.

### HMR mechanism

The main process checks if the Vite dev server is running on `localhost:5173`. If the app is on the `dev` channel and the server responds, it loads from Vite (HMR enabled). Otherwise it falls back to bundled assets via the `views://` protocol.

### Build pipeline

Vite builds `src/mainview/` → `dist/`. Electrobun copies `dist/` contents into `views/mainview/` for packaging. Config in `electrobun.config.ts`.

### Drag-and-drop file paths (heuristic)

WKWebView (used by Electrobun) does **not** expose native file paths in drag-and-drop events. The renderer only gets `file.name`, `file.size`, and `file.lastModified` from the browser File API — no real path.

To work around this, `resolveFilename` in `src/bun/rpc-handlers.ts` uses **macOS Spotlight (`mdfind`)** to search for the file by name, then verifies candidates by size and lastModified. This is a **best-effort heuristic**, not a guaranteed resolution. See [decision 005](decisions/005-dnd-file-path-heuristic.md) for details.

### Process spawning (`Bun.spawn`)

**NEVER use `Bun.spawn` or `Bun.spawnSync` directly.** Always import and use `spawn` / `spawnSync` from `src/bun/spawn.ts`.

macOS `.app` bundles inherit a minimal PATH (`/usr/bin:/bin:/usr/sbin:/sbin`). We resolve the user's full PATH at startup (`shell-env.ts` → `index.ts`) and patch `process.env.PATH`, but `Bun.spawn` without an explicit `env` option does not pick up the patched value. The `spawn.ts` wrapper always passes `{ ...process.env, ...opts.env }`, ensuring every child process sees the full user PATH (homebrew, nvm, etc.).

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

## Internationalization (i18n)

All user-facing strings in the renderer are localized. The i18n system lives in `src/mainview/i18n/` and supports three locales: **English** (default), **Russian**, and **Spanish**.

**Strict rule: NEVER hardcode user-facing strings in components.** Always use the `t()` function from the `useT()` hook.

### How it works

- **`useT()`** — React hook that returns the translation function `t(key)` and `t.plural(baseKey, count)`
- **`useLocale()`** — returns `[locale, setLocale]` for reading/changing the current language
- **`statusKey(status)`** — maps `TaskStatus` to the corresponding translation key (e.g., `"in-progress"` → `"status.inProgress"`)
- Translations are plain TypeScript objects in `src/mainview/i18n/translations/{en,ru,es}.ts`
- English (`en.ts`) is the source of truth — it defines the `TranslationKey` type
- Other locales must satisfy `TranslationRecord` (all keys from English must be present)
- Locale is persisted in `localStorage("dev3-locale")`, same pattern as the theme

### Adding a new string

1. Add the key to `src/mainview/i18n/translations/en.ts`
2. Add translations to `ru.ts` and `es.ts` (TypeScript will error if you forget)
3. Use `t("your.key")` in the component via `useT()`

### Interpolation

Use `{variable}` placeholders: `t("dashboard.failedAdd", { error: String(err) })`

### Pluralization

Use suffix convention `_one`, `_few`, `_many`, `_other`:

```ts
// en.ts — English only needs _one and _other
"dashboard.projectCount_one": "{count} project",
"dashboard.projectCount_other": "{count} projects",

// ru.ts — Russian needs _one, _few, _many, _other
"dashboard.projectCount_one": "{count} проект",
"dashboard.projectCount_few": "{count} проекта",
"dashboard.projectCount_many": "{count} проектов",
"dashboard.projectCount_other": "{count} проектов",
```

Call with `t.plural("dashboard.projectCount", count)`.

### Adding a new locale

1. Create `src/mainview/i18n/translations/{locale}.ts` with type `TranslationRecord & Record<string, string>`
2. Add the locale to `ALL_LOCALES` and `LOCALE_LABELS` in `src/mainview/i18n/types.ts`
3. Import and register in `src/mainview/i18n/context.tsx` (`translationSets`)
4. Add plural rules in `src/mainview/i18n/interpolate.ts` (`getPluralForm`)

### What NOT to translate

- Input placeholders that are command examples (`"bun install"`, `"claude"`, `"main"`)
- Terminal output (escape sequences written via `term.writeln()`)
- App name in breadcrumbs (`"dev-3.0"`)

## Testing

**Framework: Vitest** with `happy-dom` environment and React Testing Library. Config in `vitest.config.ts`.

```bash
# Run all tests once
bun run test

# Watch mode (re-runs on file changes)
bun run test:watch
```

### Where tests live

Test files go in `__tests__/` directories next to the modules they test:

```
src/mainview/i18n/__tests__/interpolate.test.ts
src/mainview/__tests__/state.test.ts
src/mainview/components/__tests__/Dashboard.test.tsx
```

### Mocking Electrobun RPC

Components that import `api` from `rpc.ts` need the Electrobun native module mocked. Use `vi.mock`:

```ts
vi.mock("../../rpc", () => ({
	api: {
		request: {
			pickFolder: vi.fn(),
			addProject: vi.fn(),
			// ... add methods your test needs
		},
	},
}));
```

### Wrapping components with providers

Components using `useT()` must be wrapped in `<I18nProvider>`:

```tsx
import { I18nProvider } from "../../i18n";

render(
	<I18nProvider>
		<YourComponent />
	</I18nProvider>,
);
```

## Key config files

- `electrobun.config.ts` — Electrobun app config (name, identifier, build copy rules)
- `vite.config.ts` — Vite config (root: `src/mainview`, output: `dist/`)
- `tailwind.config.js` — Tailwind scans `src/mainview/**/*.{html,js,ts,jsx,tsx}`
- `tsconfig.json` — Strict mode, ES2020 target, bundler module resolution
