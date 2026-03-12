# AGENTS.md

This file provides guidance to AI coding agents when working with code in this repository.

> **Note:** `CLAUDE.md` is a symbolic link to this file (`AGENTS.md`). This is intentional — it ensures all agents (Claude Code, Cursor, Codex, etc.) read the same instructions regardless of which filename convention they follow. If you see both files changed in a diff, that's expected.

## What is this

A **terminal-centric project manager** — iTerm2 meets Kanban. Desktop app for managing multiple AI coding agents and terminal-based tools across tasks and projects. Built with **Electrobun** (not Electron), React 18, Tailwind CSS, and Vite. Runtime is Bun. Currently **macOS only** (Linux and Windows support is planned).

Key idea: each project is a git repo, each task gets its own **git worktree** + **terminal** running inside **tmux** with a preconfigured command (e.g., `claude`).

**Full product concept, design details, and implementation status tracker:** see [`concept.md`](concept.md).

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

## Parallelism — prefer TeamCreate over sub-agents

When you need to delegate work to other agents, **use `TeamCreate` (team members) instead of the `Agent` tool (sub-agents)** whenever possible. Team members run as independent peers and are more efficient for parallel workloads.

**Exception:** If a team member itself needs to spawn a helper for its own sub-task, it may use the `Agent` tool internally. The rule applies to **your** direct delegation decisions — not to what team members do inside their own execution.

## Git

### Worktree

Agents in this project typically run inside a **git worktree**, not the main working tree. Find the main project path with `git worktree list` (the first entry is the main working tree). When you need to reference the original project (e.g., to read a secret, copy a config, or inspect the main branch state), use that path. Never write to the main working tree from a worktree — only read.

### Branch naming

Worktree branches are auto-generated with opaque names like `dev3/task-8711d3e1`. Once you understand what the task is about, **rename the branch automatically** to something descriptive using `git branch -m <old> <type>/<slug>`. Do not ask for permission — just do it on session start.

> **User preferences override these defaults.** If the user's CLAUDE.md, AGENTS.md, or auto-memory specifies a different branch naming convention (e.g., JIRA ticket prefix, custom format), follow the user's convention instead of the defaults below.

**Default rules** (apply only when the user has no custom branch naming preference):
- Use a conventional type prefix: `feat/`, `fix/`, `chore/`, `refactor/`, `docs/`.
- Use lowercase kebab-case: `fix/auth-race-condition`, `feat/drag-reorder`, `refactor/rpc-handlers`.
- Derive the slug from the task description/title — 3-5 words max.

**Always applies:**
- If the branch already has a meaningful name (doesn't match `dev3/task-*`), skip renaming.
- If the branch was already pushed to the remote, also update the remote: `git push origin :<old-branch> && git push -u origin <new-branch>`.

### Committing

- **Commit immediately after making changes — in English only.** Do not wait for the user to ask — commit as soon as a logical unit of work is done. Do NOT `git push` automatically — let the user decide when to push.
- **Always commit `.claude/` directory changes.** The `.claude/` directory (e.g., `settings.local.json`) is modified automatically during agent sessions via UI interactions. These changes are part of your session — always include them in your commits.

### GitHub CLI (`gh`)

The repo is owned by the **`h0x91b`** personal account. The developer machine has two `gh` accounts configured (`h0x91b` and `h0x91b-wix`). Before running any `gh` commands that access this repo, **switch to the correct account** if it is configured:

```bash
unset GH_TOKEN && gh auth switch --user h0x91b 2>/dev/null || true
```

This is a no-op for collaborators who don't have the `h0x91b` account — `gh` will fall back to whatever account they have configured. Always prefix `gh` calls with `unset GH_TOKEN &&` to avoid token conflicts (see global CLAUDE.md).

## Changelog policy

**For every code change, create a changelog entry file.** This avoids merge conflicts when multiple agents work in parallel.

**Path:** `change-logs/YYYY/MM/DD/<type>-<short-slug>.md`

**Type prefixes:** `feature-`, `fix-`, `refactor-`, `docs-`, `chore-`

**Content:** Plain text, 1-3 sentences describing what was done. No frontmatter, no headers. **Keep it short — one paragraph max.**

**Rules:**
- Include the changelog file in the same commit as the code change.
- The slug must be unique and descriptive enough to avoid collisions between parallel agents.
- **One worktree = one changelog file.** A single task (worktree) must produce exactly one changelog entry for the entire session — not one per commit, not one per feature. If the task evolves, update or append to the existing changelog file rather than creating new ones.
- **Credit community contributors.** If the feature or fix originated from a GitHub issue (i.e., was requested or reported by an external user), add a blank line and then `Suggested by @username (h0x91b/dev-3.0#N)` at the **end** of the changelog file. The parser extracts this into `suggestedBy`, `issueRef`, and `issueUrl` fields, displayed in the changelog UI as a linked credit line. Example: `Suggested by @roiros (h0x91b/dev-3.0#191)`.
- See `change-logs/README.md` for the full format specification.

## Feature discovery tips

**Every user-facing feature must include 1–2 "Did you know?" tips** (small feature → 1, large → 2). Bug fixes/refactors — skip. Include tips in the same commit as the feature.

**Files:** tip registry in `src/mainview/tips.ts` (`ALL_TIPS` array), i18n keys `tip.<id>.title` / `tip.<id>.body` in `{en,ru,es}.ts`. See existing tips for the pattern.

**Content:** title 3–6 words, body one sentence max ~120 chars — tell the user *what to do*, no fluff. Icon: Nerd Font glyph (`\u{XXXXX}`).

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

### RPC protocol

The renderer and main process communicate via **Electrobun's built-in RPC** (IPC bridge). The schema is defined in `src/shared/types.ts` as `AppRPCSchema` with two channels: `bun` (main process) and `webview` (renderer).

- **Request/response:** Components call `api.request.METHOD(params)` (returns a Promise, 2-minute timeout). Handlers are registered in `src/bun/rpc-handlers.ts`.
- **Push messages:** The main process sends unsolicited updates via `pushMessage?.("eventName", payload)`. The renderer dispatches these as `CustomEvent`s (e.g., `rpc:taskUpdated`), which components listen to with `window.addEventListener()`.

### State management

UI state uses React's **`useReducer`** pattern (no external state library). The store lives in `src/mainview/state.ts`:

- `useAppState()` hook wraps `useReducer(reducer, initialState)` — state includes routing, project/task lists, and UI flags.
- Components call `api.request.*` to fetch/mutate backend data, then `dispatch()` reducer actions to update local state.
- Push messages from the main process trigger event listeners that dispatch actions to keep the UI in sync.

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

### Agent skill injection

The app auto-installs the **dev3 skill** into AI agent config directories (`~/.claude/skills/dev3/`, `~/.codex/skills/dev3/`, etc.) on every startup. The skill file is **generated from source** — the template lives in `src/bun/agent-skills.ts` (`SKILL_CONTENT` constant). **Never edit the generated `SKILL.md` files directly** — they are overwritten on each app launch. To change the skill content, edit `agent-skills.ts`.

The skill uses the Claude Code `allowed-tools` frontmatter field to control which tools are auto-permitted when the skill is active. Omitting `allowed-tools` entirely means the skill imposes no tool restrictions (the user's normal permission settings apply). Adding `allowed-tools: Bash` would restrict the skill to only the Bash tool.

**Feature differences between agents** (hooks, skill variants, CLI flags, integrations) are tracked in [`agent-support-matrix.md`](agent-support-matrix.md). **Keep this file up to date** when adding or changing agent-specific behavior.

## Project scripts

Each project has three lifecycle scripts, configurable in Project Settings (`src/mainview/components/ProjectSettings.tsx`). They are stored in `projects.json` as fields on the `Project` type (`src/shared/types.ts`).

| Field | When it runs |
|---|---|
| `setupScript` | After a new worktree is created for a task |
| `devScript` | When starting the dev server for the project (not yet wired up — reserved for future use) |
| `cleanupScript` | When a task is moved to `cancelled` status (and `archived` once that status is added) |

All three are free-form shell scripts. They are saved via the `updateProjectSettings` RPC handler in `src/bun/rpc-handlers.ts`.

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

### Nerd Font icons in the renderer

The app bundles **JetBrainsMono Nerd Font Mono** (`src/mainview/assets/fonts/`), loaded via `@font-face` in `index.css`. Use Nerd Font glyphs for icons instead of SVGs wherever possible.

**How to use in JSX:**

```tsx
<span
  className="text-[1.125rem] leading-none"
  style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}
>
  {"\u{F0645}"}
</span>
```

**Rules:**
- **Always wrap font-family in single quotes** inside the style object: `"'JetBrainsMono Nerd Font Mono'"`. Without inner quotes, multi-word font names may not resolve.
- **Use ES6 unicode escapes** for codepoints above U+FFFF: `"\u{F0645}"` (curly braces). The classic `"\uF0645"` silently parses as `"\uF064"` + `"5"` — only 4 hex digits are consumed.
- For codepoints U+0000–U+FFFF, classic `"\uF188"` works fine.
- Browse glyphs at [nerdfonts.com/cheat-sheet](https://www.nerdfonts.com/cheat-sheet). Use the hex codepoint from there directly.
- See `GlobalHeader.tsx` (bug icon `\uf188`) and `TaskInfoPanel.tsx` (file-tree icon `\u{F0645}`) for working examples.

## Internationalization (i18n)

All user-facing strings in the renderer are localized. The i18n system lives in `src/mainview/i18n/` and supports three locales: **English** (default), **Russian**, and **Spanish**.

**Strict rule: NEVER hardcode user-facing strings in components.** Always use the `t()` function from the `useT()` hook.

### How it works

- **`useT()`** — React hook that returns the translation function `t(key)` and `t.plural(baseKey, count)`
- **`useLocale()`** — returns `[locale, setLocale]` for reading/changing the current language
- **`statusKey(status)`** — maps `TaskStatus` to the corresponding translation key (e.g., `"in-progress"` → `"status.inProgress"`)
- Translations are split into **domain files** under `src/mainview/i18n/translations/{en,ru,es}/` (e.g., `common.ts`, `kanban.ts`, `tips.ts`, `settings.ts`). Each locale's barrel file (`en.ts`, `ru.ts`, `es.ts`) re-exports the merged object.
- English (`en.ts`) is the source of truth — it defines the `TranslationKey` type
- Other locales must satisfy `TranslationRecord` (all keys from English must be present)
- Locale is persisted in `localStorage("dev3-locale")`, same pattern as the theme

### Adding a new string

1. Find the matching domain file under `src/mainview/i18n/translations/en/` (e.g., `kanban.ts` for `kanban.*` keys, `tips.ts` for `tip.*` keys)
2. Add the key to that domain file, then add translations to the same domain file in `ru/` and `es/` (TypeScript will error if you forget)
3. Use `t("your.key")` in the component via `useT()`
4. **Never edit the barrel files** (`en.ts`, `ru.ts`, `es.ts`) directly — only edit domain files

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

**Framework: Vitest** with `happy-dom` environment and React Testing Library. Three configs: `vitest.config.ts` (mainview), `vitest.config.bun.ts` (backend), `vitest.config.cli.ts` (CLI).

```bash
bun run lint          # TypeScript type-check (must pass before committing)
bun run test          # Fast tests — mainview + bun in parallel, excludes 3 slow e2e files (~6s)
bun run test:full     # Full tests — everything including slow e2e files (~42s, for CI/PR)
bun run test:bun      # Backend tests only
bun run test:cli      # CLI tests
bun run test:watch    # Watch mode
```

> **Note:** When running vitest directly (outside `bun run`), use `bunx vitest run` — not `npx`.

> **Rule:** Always run both `bun run lint` **and** `bun run test` before committing. A commit that breaks type-checking is not acceptable, even if tests pass. Fix all TypeScript errors before pushing.

### Coverage requirements

Overall thresholds: **70% lines, 65% branches, 70% functions**.

Critical modules must reach **85% lines, 80% branches**: `state.ts`, `src/shared/types.ts` (helpers), `src/mainview/i18n/`, `src/cli/`, `src/bun/data.ts`, `src/bun/git.ts`, `src/mainview/utils/`.

Excluded from coverage (bootstrap/wrappers that only make sense in e2e): `src/bun/index.ts`, `src/bun/updater.ts`, `src/bun/shell-env.ts`, `src/bun/spawn.ts`, `src/mainview/rpc.ts`, `src/mainview/main.tsx`.

### What to test

**Unit tests (mandatory):** state reducer actions + edge cases, all pure functions/utils/parsers, every RPC handler (happy path + 2-3 error cases), CLI commands (parsing + validation + output), data layer CRUD + corrupt data handling, git operations with mocked spawn, i18n interpolation + pluralization for all locales.

**Component tests (mandatory):** All major interactive components — board views, task cards, modals, settings panels. Always use `userEvent` (not `fireEvent`). Test behavior, not implementation.

**E2E tests (CLI-based):** Full lifecycle through CLI + Unix socket against a real app process with tmpdir. Scenarios: task lifecycle (create → move statuses → complete), project CRUD, worktree creation + cleanup, notes CRUD, CLI context auto-detection, concurrent writes (no data corruption).

### Bug fixing workflow — reproduce first

**When fixing a bug, always start by writing a failing test that reproduces the issue.** Do not jump straight to the fix.

1. **Write a unit or e2e test** that triggers the exact bug (the test must fail / turn red).
2. **Then fix the code** so the test passes (turns green).
3. Commit both the test and the fix together.

This ensures the bug is properly understood before being fixed, and prevents regressions.

**Exception:** If the bug is genuinely impractical to reproduce in a test (e.g., it depends on OS-specific timing, hardware, or third-party service behavior that cannot be mocked), skip the reproduction test. But this should be rare — default to writing the test first.

### Test writing rules

- One logical assertion per test. No dependencies between tests.
- Mock only external boundaries (git, tmux, fs, Electrobun), not internal modules.
- No `sleep`/timers — use proper async/await.
- Every new feature or bug fix must include tests. PRs that decrease coverage below thresholds are rejected.

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

## Documentation

Local documentation for key dependencies lives in `vendor-docs/`:

| Directory | What's inside | How to use |
|---|---|---|
| `vendor-docs/electrobun/` | Local markdown docs (APIs, guides) | Read files directly |
| `vendor-docs/ghostty-web/` | Local markdown docs (API, guides) | Read files directly |
| `vendor-docs/bun/` | Pointer to Bun's `llms.txt` | Fetch `https://bun.com/docs/llms-full.txt` for full docs in one request, or see `vendor-docs/bun/README.md` for all links |

**Before writing code that touches a dependency, check `vendor-docs/` first.** Read the relevant local docs or fetch remote ones as instructed. Do not guess APIs from memory — verify against the docs.

## Recent large-scale changes

**Memory leak audit (March 2026):** PRs #294, #295, #296 touched many files across `src/bun/rpc-handlers.ts`, `src/bun/git.ts`, `src/mainview/components/`, `src/mainview/hooks/`, `src/cli/socket-client.ts`, and `src/mainview/analytics.ts`. If you encounter a regression or unexpected behavior in any of these areas, **read [`decisions/015-memory-leak-fixes-side-effects.md`](decisions/015-memory-leak-fixes-side-effects.md) first** — it documents every change and its potential side effects.

## Landing page (GitHub Pages)

The `docs/` directory hosts the **public landing page** served via GitHub Pages at `https://h0x91b.github.io/dev-3.0/`. Source: `docs/index.html`. Screenshots live in `docs/screenshots/`.
