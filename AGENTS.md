# AGENTS.md

This file provides guidance to AI coding agents when working with code in this repository.

> **Note:** `CLAUDE.md` is a symbolic link to this file (`AGENTS.md`). This is intentional — it ensures all agents (Claude Code, Cursor, Codex, etc.) read the same instructions regardless of which filename convention they follow. If you see both files changed in a diff, that's expected.

## Response style

**Default writing style: Decision-First.**

When replying to the user, optimize for fast scanning and minimum necessary text.

Rules:
- Use this section order when structure is needed:
  `============= [CANDIDATES] =============`
  `============== [DECISION] ==============`
  `================ [WHY] =================`
  `================ [NEXT] ================`
- Show `2-5` candidates in `CANDIDATES`.
- Mark the selected candidate with `(chosen)`.
- Each candidate may use up to 5 short lines.
- `CANDIDATES` is for concise option framing, not full justification.
- `DECISION` is where the chosen option is explained in more detail.
- Keep each section to short paragraphs or a flat list of concrete steps.
- Prefer short sentences, concrete nouns, and direct verbs.
- Do not repeat the same point in different words.
- Do not add background unless it changes the decision.
- For code changes, always end the final reply with the repo-mandated `## Test instructions` block.
- Keep the section labels uppercase and the divider width visually consistent every time.
- If a sentence does not add new information, remove it.
- Aim for something the user can read in 10-15 seconds for normal task updates.

## What is this

A **terminal-centric project manager** — iTerm2 meets Kanban. Desktop app for managing multiple AI coding agents and terminal-based tools across tasks and projects. Built with **Electrobun** (not Electron), React 19, Tailwind CSS, and Vite. Runtime is Bun. Supports **macOS and Linux** (Windows support is planned).

Key idea: each project is a git repo, each task gets its own **git worktree** + **terminal** running inside **tmux** with a preconfigured command (e.g., `claude`).

**Full product concept, design details, and implementation status tracker:** see [`concept.md`](concept.md).

**Design system specification (colors, typography, components, glass morphism, themes):** see [`DESIGN.md`](DESIGN.md). Follow it when generating any UI code.

**UX architecture manifest (object model, navigation, surfaces, action taxonomy, placement rules, complexity budgets):** see [`docs/ux/PRODUCT_UX_BIBLE.md`](docs/ux/PRODUCT_UX_BIBLE.md) and its machine-readable companion [`docs/ux/ux-architecture.yaml`](docs/ux/ux-architecture.yaml). This is the canonical UX reference — where features live, which surface owns which action, and the rules that keep toolbars/inspectors from bloating.

## UI/UX work — always plan with `/ux-principal` (MANDATORY)

**Before designing or implementing anything UI/UX-related** — a new screen, surface, button, modal, toolbar action, navigation change, or any visible control — you MUST first invoke the `/ux-principal` skill. It reads the UX manifest above, classifies the feature, decides correct placement, navigation, action hierarchy, token roles, and complexity budget, and produces an implementation brief. Do NOT add UI controls ad hoc without this step — that is exactly how toolbar/inspector button creep (the project's top UX anti-pattern) happens.

When the manifest itself is stale or missing, use `/ux-create-manifest` to regenerate it. Keep `docs/ux/` updated whenever surfaces or the action taxonomy change.

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

## Parallelism — TeamCreate over Agent tool (MANDATORY)

**STOP before calling the `Agent` tool.** If you are about to spawn one or more agents for research, investigation, or parallel work — **use `TeamCreate` instead.** This is not a suggestion; it is the default. Team members run as independent peers with full tool access and are the correct mechanism for delegation in this project.

**Self-check trigger:** Every time you are about to type `Agent` in a tool call, ask yourself: "Can this be a team member?" If yes — use `TeamCreate`. If you catch yourself having already used `Agent` where `TeamCreate` would work — note the mistake and correct course.

**The only valid reasons to use `Agent` directly:**
- A team member itself needs a sub-agent for its own internal sub-task (you are not the one spawning it).
- The task is trivially small (single file read, single grep) where a dedicated tool (`Read`, `Grep`, `Glob`) is more appropriate than any delegation at all.

**If in doubt, use `TeamCreate`.** Defaulting to `Agent` out of habit is exactly what this rule prevents.

## On-disk data layout — hard invariants (MANDATORY)

The `~/.dev3.0/` directory is shared between **every installed version** of the app on the user's machine: production (`~/Applications/dev-3.0.app`), dev builds, `bun run dev` runs, side-by-side channels. Any change that breaks forward/backward compatibility of that directory breaks whichever version happens to open it next. This has already burned us once (PR #486 → reverted in #488); see `decisions/039-revert-project-slug-dash-escape.md`.

**The following are not negotiable. Do not violate them, even for "clean" fixes.**

1. **`projectSlug()` algorithm is frozen.** The function in `src/bun/git.ts` maps `/a/b/c` → `a-b-c` and must not change. This is the canonical name used for `~/.dev3.0/data/<slug>/`, `~/.dev3.0/worktrees/<slug>/`, and for CLI worktree context detection. If you think you have a good reason to change it — stop. Discuss it with the user first, with a concrete migration plan that does not touch existing data on disk.
2. **No automatic renames of anything under `~/.dev3.0/`.** Never call `renameSync`, `rename`, `mv`, or any equivalent on `~/.dev3.0/data/*`, `~/.dev3.0/worktrees/*`, `~/.dev3.0/projects.json`, `~/.dev3.0/tasks.json`, `~/.dev3.0/sockets/*`, or any sibling. Not at startup, not in a migration hook, not "just this once". An older version of the app still running on the same machine will look in the pre-rename path, find nothing, and silently show an empty Kanban board.
3. **No destructive migrations of user state at load time.** `rawLoadAllProjects` and friends may **rewrite file contents** in place if the schema genuinely evolves (see the `say` cleanup-script migration) — that is fine because the file path is unchanged. They must **never** move, rename, or delete directories or files. If a migration cannot be done in place, it is not allowed; design it differently.
4. **CLI worktree detection relies on the plain slug.** `src/cli/context.ts` reads `projects.json` and recomputes `path.replace(/^\//, "").replaceAll("/", "-")` inline. If the slug algorithm ever drifts from this, CLI auto-detection of `taskId` from `cwd` breaks, and every agent hook that relies on it (`dev3 task move --status in-progress --if-status-not review-by-ai`, etc.) starts failing. Keep the two in lockstep — but see rule 1: the preferred solution is to not change the algorithm at all.
5. **If you are convinced a change is unavoidable,** do it behind a new parallel path (e.g. write a new file alongside the old one, read both, prefer the new), keep the old path readable by at least N-2 versions, and document the sunset plan in a decision record before writing code. No silent in-place rewrites.

These rules apply to any new code that touches `~/.dev3.0/`, any refactor of `src/bun/data.ts` / `src/bun/git.ts` / `src/bun/paths.ts` / `src/cli/context.ts`, and any "cleanup" that thinks it can tidy up the data directory.

## Git

### Worktree

Agents in this project typically run inside a **git worktree**, not the main working tree. Find the main project path with `git worktree list` (the first entry is the main working tree). When you need to reference the original project (e.g., to read a secret, copy a config, or inspect the main branch state), use that path. Never write to the main working tree from a worktree — only read.

### Committing

- **Commit immediately after making changes — in English only.** Do not wait for the user to ask — commit as soon as a logical unit of work is done. Do NOT `git push` automatically — let the user decide when to push.
- **Always commit `.claude/` directory changes.** The `.claude/` directory (e.g., `settings.local.json`) is modified automatically during agent sessions via UI interactions. These changes are part of your session — always include them in your commits.
- **CRITICAL: never let Git open an editor.** Always pass messages inline (`git commit -m "..."`, `git tag -m "..."`) and prefer non-interactive continue commands. For operations that normally open an editor, force no-editor mode explicitly (for example `GIT_EDITOR=true git rebase --continue`, `git merge --continue --no-edit`, `git cherry-pick --continue --no-edit`). If a command would open an editor window, stop and choose a non-interactive form instead.

### GitHub CLI (`gh`)

The repo is owned by the **`h0x91b`** personal account. The developer machine has two `gh` accounts configured (`h0x91b` and `h0x91b-wix`). Before running any `gh` commands that access this repo, **switch to the correct account** if it is configured:

```bash
gh auth switch --user h0x91b 2>/dev/null || true
```

This is a no-op for collaborators who don't have the `h0x91b` account — `gh` will fall back to whatever account they have configured.

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

## Test instructions (mandatory for every task)

**Every task must end with a "Test instructions" section in the final message to the user.** This is a TL;DR at the bottom — the user should be able to test everything without reading the full conversation above.

**Format:**

```
## Test instructions

1. Go to [place in the app]
2. Click [element] / Do [action]
3. Expected: [what should happen]
...
```

**Rules:**
- **Cover the entire task, not just the latest change.** If the task involved adding button A, then button B, then button C across multiple messages — the test instructions must verify all three. Mark the most recently added item with `(new)` so the user can spot what changed in the last iteration.
- **Be specific.** "Open settings" is not enough — say "Open Settings → General tab → look for the 'Auto-save' toggle". Include exact labels, tab names, menu paths.
- **Keep it short.** One numbered step per thing to verify. No explanations of *why* — just *what to do* and *what to expect*.
- **Include negative cases if relevant.** E.g., "Try clicking X when Y is empty — should show an error toast, not crash."
- **Update, don't duplicate.** If you already posted test instructions earlier in the conversation, the new version replaces the old one entirely. Always provide the full set.

## Commands

```bash
# Main local development flow (build, package, then launch locally)
bun run dev

# Alternative local launch path (reuses existing Vite output)
bun run start

# Build (staging channel)
bun run build

# Build (production channel)
bun run build:prod
```

**HMR / Vite watch workflow is NOT used in this project.** Do not run `bun run watch`, `bun run hmr`, or any `vite --watch` flow. The only supported dev loop is `bun run dev`. Also, **never run `bun run bump`** — versioning is owned by the user, not AI agents.

Use `bun run lint` for the repository's TypeScript/type-check validation step before committing.

## CLI exit codes

Public `dev3` CLI exit codes are a documented contract.

Rules:
- Define them only in `src/shared/cli-exit-codes.ts`.
- Keep every non-zero code unique.
- Do not inline non-zero exit numbers in `src/cli/`.
- Update `docs/cli-exit-codes.md` and `src/cli/__tests__/exit-codes.test.ts` whenever a code is added or changed.

## Architecture

Two-process model:

- **Main process** (`src/bun/index.ts`): Runs in Bun via Electrobun APIs (`BrowserWindow`, `Updater`, `Utils`). Creates the app window and handles lifecycle.
- **Renderer process** (`src/mainview/`): React app bundled by Vite. Entry point is `main.tsx`, root component is `App.tsx`.

### RPC protocol

The renderer and main process communicate via **Electrobun's built-in RPC** (IPC bridge). The schema is defined in `src/shared/types.ts` as `AppRPCSchema` with two channels: `bun` (main process) and `webview` (renderer).

- **Request/response:** Components call `api.request.METHOD(params)` (returns a Promise, 2-minute timeout). Handlers live in `src/bun/rpc-handlers/*.ts`, split by domain (`app-handlers`, `settings-config`, `task-lifecycle`, `git-operations`, `tmux-pty`, `notes-labels`, `remote-access`). The root `src/bun/rpc-handlers.ts` is a barrel re-exporter that merges them into a single `handlers` object.
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

### Drag-and-drop files (uploaded into worktree)

WKWebView does not expose native host file paths in drag-and-drop events. Instead of guessing the path, dropped files are **uploaded into the task worktree** (up to 100 MB per file) and pasted as worktree-relative paths. See [decision 036](decisions/036-worktree-uploaded-dnd-files.md) for details.

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
| `cleanupScript` | Before a task worktree is removed after `completed` or `cancelled` (and `archived` once that status is added) |

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

> **Hard rule for AI agents — full test suite before push / PR:** Before `git push` (or `gh pr create`, or enabling auto-merge), you MUST run `bun run test` and see it green end-to-end. Running only the test file you just edited is NOT sufficient — code in one component is often asserted against from sibling test files (e.g. `TaskCard.tsx` is covered by both `TaskCard.test.tsx` AND `TaskCardSeq.test.tsx`). Targeted runs miss those. If `bun run test` fails, fix the failures (or update the affected assertions) and re-run until green BEFORE pushing. Do not push first and then watch CI go red — that's a wasted CI run and a noisy PR history.

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
			listDirectory: vi.fn(),
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

## Landing page (GitHub Pages)

The `docs/` directory hosts the **public landing page** served via GitHub Pages at `https://h0x91b.github.io/dev-3.0/`. Source: `docs/index.html`. Screenshots live in `docs/screenshots/`.
