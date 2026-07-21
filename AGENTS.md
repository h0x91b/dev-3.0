# AGENTS.md

This file provides guidance to AI coding agents when working with code in this repository.

> **Note:** `CLAUDE.md` is a symlink to this file (`AGENTS.md`) so all agents (Claude Code, Cursor, Codex, …) read the same instructions. Both files appearing changed in a diff is expected.

## Response style

**Default writing style: Decision-First.** Optimize replies for fast scanning and minimum necessary text.

- When structure is needed, use this section order, labels uppercase, divider width consistent:
  `============= [CANDIDATES] =============`
  `============== [DECISION] ==============`
  `================ [WHY] =================`
  `================ [NEXT] ================`
- `CANDIDATES`: 2-5 genuinely viable options — no strawmen, no filler, no "do nothing" padding. Candidates must be maximally diverse approaches (different layers, mechanisms, scopes), not cosmetic variations of one idea or "subset of the plan" vs "the plan". Up to 5 short lines each; mark the pick `(chosen)`. If only one reasonable approach exists, skip the section and say so in `DECISION` — a fake alternatives list is worse than none.
- `CANDIDATES` frames options concisely; `DECISION` explains the chosen one in more detail. Keep every section to short paragraphs or a flat list of concrete steps.
- Short sentences, concrete nouns, direct verbs. Don't repeat a point in different words; don't add background that doesn't change the decision; delete sentences that add no information. Target: readable in 10-15 seconds for normal task updates.
- For code changes, always end the final reply with the repo-mandated `## Test instructions` block.

## What is this

A **terminal-centric project manager** — iTerm2 meets Kanban. Desktop app for managing multiple AI coding agents and terminal tools across tasks and projects. Built with **Electrobun** (not Electron), React 19, Tailwind CSS, Vite; runtime is Bun. Supports macOS and Linux (Windows planned).

Key idea: each project is a git repo; each task gets its own **git worktree** + **terminal** running inside **tmux** with a preconfigured command (e.g., `claude`).

- Full product concept + implementation status tracker: [`concept.md`](concept.md)
- Design system (colors, typography, components, glass morphism, themes): [`DESIGN.md`](DESIGN.md) — follow it for any UI code
- UX architecture manifest (object model, navigation, surfaces, action taxonomy, placement rules, complexity budgets): [`docs/ux/PRODUCT_UX_BIBLE.md`](docs/ux/PRODUCT_UX_BIBLE.md) + machine-readable [`docs/ux/ux-architecture.yaml`](docs/ux/ux-architecture.yaml) — the canonical UX reference for where features live and which surface owns which action

## UI/UX work — always plan with `/ux-principal` (MANDATORY)

Before designing or implementing **anything** UI/UX-related — a new screen, surface, button, modal, toolbar action, navigation change, any visible control — you MUST first invoke the `/ux-principal` skill. It reads the UX manifest, classifies the feature, decides placement, navigation, action hierarchy, token roles, and complexity budget, and produces an implementation brief. Never add UI controls ad hoc — that is exactly how toolbar/inspector button creep (the project's top UX anti-pattern) happens.

If the manifest is stale or missing, regenerate it with `/ux-create-manifest`. Keep `docs/ux/` updated whenever surfaces or the action taxonomy change.

**Bookend `/ux-principal` with `/debug-ui`:** *before* planning, drive the current UI and screenshot the zones you're about to touch — grounding the plan in what's actually on screen beats reasoning from memory; *after* implementing, verify in a browser before review. See [Manual UI QA in a browser](#manual-ui-qa-in-a-browser).

## No native dialogs — ever (remote/browser mode) (MANDATORY)

The app runs as the **Electrobun desktop** shell **and** as a **headless remote mode served to a browser** (`dev3 remote`). Anything that depends on the native OS shell silently breaks in the browser. **Native blocking dialogs are banned — do not add new ones; prefer replacing existing ones.**

**Forbidden for user-facing flows:**
- `Utils.showMessageBox` (Electrobun) — runs only in the bun/desktop process; the browser transport cannot render it.
- `Utils.openFileDialog` (Electrobun) — already replaced by the React folder picker (`src/mainview/components/FolderPickerModal.tsx` + `folder-picker.ts`, `listDirectory` RPC). Use that.
- `window.alert()`, `window.confirm()`, `window.prompt()` — blocking, untheme-able remote UX; banned even though they technically work in a browser tab.

**Use instead (in-app React, identical in desktop and browser):**
- Confirmation → the imperative `confirm()` service (`src/mainview/confirm.tsx`, `useConfirm` / module-level `confirm({ title, message, danger? }) => Promise<boolean>`), rendered by a single host mounted in `App.tsx`.
- Errors / info / success → the toast service (`src/mainview/toast.tsx`, `toast.error()/info()/success()`).
- Anything richer → a regular React modal (see existing `*Modal.tsx` components).

**Exception — genuinely OS-level chrome, not dialogs:** `Utils.showNotification` (Notification Center) and the native macOS menu bar (`application-menu.ts`) are allowed (they no-op / are absent in browser mode). Any *dialog* triggered from a menu action must be routed to the renderer via a push message and shown as React UI.

## Language policy

**All code-related content MUST be in English — no exceptions:** commit messages, changelog files (`change-logs/`), code comments and docstrings, decision records (`decisions/`), PR titles/descriptions, any text written inside source files. The user may communicate in Russian; everything written into the codebase or git history is English-only.

## Code comments — self-documenting first

**Aim for code that explains itself** (clear names, small functions) and add comments only where they earn their place. **Cap: a comment ≤ 3 lines.** The only exception is a genuinely weird, non-obvious use case (a workaround, a subtle invariant, a "why not the obvious thing") — those may go longer, and belong in a `decisions/NNN-*.md` record if substantial. Don't restate what the code already says, don't narrate obvious steps, don't leave changelog-style history in comments.

## Parallelism — TeamCreate over Agent tool (MANDATORY)

When spawning agents for research, investigation, or parallel work — **use `TeamCreate`, not the `Agent` tool.** Team members run as independent peers with full tool access and are the correct delegation mechanism in this project. The only valid direct uses of `Agent`: a team member spawning a sub-agent for its own internal sub-task, or work so trivial (single file read, single grep) that a dedicated tool (`Read`, `Grep`, `Glob`) beats any delegation. If in doubt, use `TeamCreate`.

## On-disk data layout — hard invariants (MANDATORY)

The `~/.dev3.0/` directory is shared between **every installed version** of the app on the user's machine (production, dev builds, `bun run dev`, side-by-side channels). Any change that breaks forward/backward compatibility of that directory breaks whichever version opens it next. This already burned us once (PR #486 → reverted in #488; see `decisions/039-revert-project-slug-dash-escape.md`). **Not negotiable, even for "clean" fixes:**

1. **`projectSlug()` algorithm is frozen.** The function in `src/bun/git.ts` maps `/a/b/c` → `a-b-c` and must not change — it names `~/.dev3.0/data/<slug>/`, `~/.dev3.0/worktrees/<slug>/`, and CLI worktree context detection. If you think you have a good reason to change it — stop and discuss with the user first, with a concrete migration plan that does not touch existing data on disk.
2. **No automatic renames of anything under `~/.dev3.0/`.** Never `rename`/`renameSync`/`mv` `~/.dev3.0/data/*`, `worktrees/*`, `projects.json`, `tasks.json`, `sockets/*`, or any sibling — not at startup, not in a migration hook, not "just this once". An older version still running on the machine will look at the pre-rename path, find nothing, and silently show an empty Kanban board.
3. **No destructive migrations of user state at load time.** `rawLoadAllProjects` and friends may rewrite file **contents** in place when the schema genuinely evolves (see the `say` cleanup-script migration) — the path stays unchanged. They must never move, rename, or delete directories or files. If a migration cannot be done in place, design it differently.
4. **CLI worktree detection relies on the plain slug.** `src/cli/context.ts` reads `projects.json` and recomputes `path.replace(/^\//, "").replaceAll("/", "-")` inline. If the slug algorithm drifts from this, CLI auto-detection of `taskId` from `cwd` breaks, and every agent hook relying on it (e.g. `dev3 task move --status in-progress --if-status-not review-by-ai`) starts failing. Keep the two in lockstep — but per rule 1, prefer not touching the algorithm at all.
5. **If a change is truly unavoidable,** do it behind a new parallel path (write a new file alongside the old, read both, prefer the new), keep the old path readable for at least N-2 versions, and document the sunset plan in a decision record before writing code. No silent in-place rewrites.

These rules apply to any code touching `~/.dev3.0/`, any refactor of `src/bun/data.ts` / `src/bun/git.ts` / `src/bun/paths.ts` / `src/cli/context.ts`, and any "cleanup" of the data directory.

## Update channels — brew deps are NOT guaranteed (MANDATORY)

Two independent update channels deliver different things:

1. **Homebrew** (`brew install/upgrade --cask dev3`) — installs the app **and** its brew dependencies (`git`, the pinned `h0x91b/dev3/tmux@3.6` keg, `cloudflared`).
2. **In-app updater** (Electrobun `Updater`; also DMG/tarball installs) — swaps **only the `.app` bundle**. It cannot run brew, so any dependency added to the cask/formula after the user's original install **will be missing** on these machines.

Hard rules for any feature that leans on an external binary:

- **Never assume a brew dependency exists.** A new `depends_on` in `release.yml` reaches only brew users. Every code path must degrade gracefully when the vendored/pinned binary is absent (fall back to PATH, feature-gate, or log a warning with the install command — never crash or break existing flows).
- **Explicitly test the "in-app updated, dependency missing" configuration** — it is the *majority* upgrade path, not an edge case. The tmux@3.6 pin shipped green on dev machines (keg present) but broke updater users: PATH resolution found our own `~/.dev3.0/bin/tmux` shim (that dir is first in PATH — it hosts the dev3 CLI) and symlinked it onto itself → ELOOP, every tmux spawn dead (v1.29.1 incident; post-mortem in `decisions/105-pin-tmux-3.6-vendored-keg.md`).
- **Any shim placed into `~/.dev3.0/bin` must be excluded from that binary's own PATH resolution** — dereference it, never commit it as the resolved binary, and sanitize a broken shim at startup (reference pattern: `dereferenceTmuxShim`/`sanitizeTmuxShim` in `src/bun/pty-server.ts`).

## Git

### Worktree

Agents typically run inside a **git worktree**, not the main working tree. Find the main project path with `git worktree list` (first entry). Use it when you need the original project (read a secret, copy a config, inspect main branch state). Never write to the main working tree from a worktree — read only.

### Committing

- **Commit immediately after each logical unit of work — messages in English only.** Don't wait to be asked. Do NOT `git push` automatically — the user decides when to push.
- **Always commit `.claude/` directory changes** (e.g., `settings.local.json`) — they are modified automatically during agent sessions and are part of your session.
- **CRITICAL: never let Git open an editor.** Pass messages inline (`git commit -m`, `git tag -m`) and force non-interactive continues: `GIT_EDITOR=true git rebase --continue`, `git merge --continue --no-edit`, `git cherry-pick --continue --no-edit`. If a command would open an editor window, choose a non-interactive form instead.

### GitHub CLI (`gh`)

The repo is owned by the personal **`h0x91b`** account; the dev machine also has `h0x91b-wix` configured. Before `gh` commands against this repo:

```bash
gh auth switch --user h0x91b 2>/dev/null || true
```

(No-op for collaborators without that account.)

**PRs are squash-merged.** Always pass the strategy flag: `gh pr merge --auto --squash <branch>` — a bare `gh pr merge --auto` fails non-interactively.

### Task completion

**Preservation gate (mandatory):** Never move a task to `completed`, and never request completion approval, while the task's work exists only in a disposable worktree. Completion is allowed when either the result is safely preserved in the destination the task requires — commonly a pull request merged into `main`, but it may be an external file, task note, shared artifact, or another explicit destination — or the user explicitly asks to complete the task. A local commit, passing tests, or an open/unmerged pull request is not enough by itself. If the required destination is unclear or the work is not safely preserved, keep the task open and ask the user.

## Changelog policy

**Every code change gets a changelog entry file** (avoids merge conflicts between parallel agents).

**Path:** `change-logs/YYYY/MM/DD/<type>-[<NN>-]<short-slug>.md` — type prefixes: `feature-`, `fix-`, `refactor-`, `docs-`, `chore-`. An optional two-digit `NN` right after the type ranks features in the update popover (`00` = most prominent) — see the popover-priority rule below.

**The `YYYY/MM/DD` is the expected PR merge date, not the start date.** If the task spans days, move (rename) the entry before opening/merging the PR so it matches the actual merge day (with auto-merge, normally the day you open the PR) — the changelog UI groups by ship date.

**Content:** plain text, 1-3 sentences, no frontmatter/headers, one paragraph max.

Rules:
- Include the changelog file in the same commit as the code change.
- Slug must be unique and descriptive enough that parallel agents don't collide.
- **`Short:` line (mandatory for `feature-` entries):** first line `Short: <≤6 words, no trailing period>`, then a blank line, then the content. It feeds the update-ready popover's "what's new" preview (features lead it); the full first sentence still drives the Changelog screen. `fix-` entries add one when user-visible; otherwise a crude fallback is derived. See `change-logs/README.md`.
- **Popover priority (`<type>-<NN>-<slug>`, optional):** the update popover has room for only the top `MAX_POPOVER_FEATURES` features and rolls the rest into "+N more". Insert a two-digit `NN` right after the type to control which ones win those slots — `00` = most prominent (demo-reel "wow"), higher = lower; omit it and the entry sits mid-pack (priority 50). Numbering only reorders **features** (the slotted list); `fix-`/others merely contribute a count, so numbering them is optional. Type is still parsed from the first dash, so `feature-00-foo` stays type `feature`. Rank honestly (reuse the tips coolness rubric) and push dev-only/internal features to a high number so they never eat a user-facing slot.
- **One worktree = one changelog file** — a single task produces exactly one entry for the whole session, not one per commit or per feature; if the task evolves, update/append the existing file.
- **Credit community contributors:** if the change originated from a GitHub issue by an external user, end the file with a blank line then `Suggested by @username (h0x91b/dev-3.0#N)` — parsed into `suggestedBy`/`issueRef`/`issueUrl` and shown in the changelog UI as a linked credit. Example: `Suggested by @roiros (h0x91b/dev-3.0#191)`.
- Full format spec: `change-logs/README.md`.

## Feature discovery tips

**A tip is earned, not mandatory.** The "Did you know?" registry surfaces **non-obvious capabilities the user would otherwise never find** — it is NOT a changelog. Default for any change, including most user-facing features: **zero tips**; bug fixes/refactors: never. Every low-value tip dilutes the good ones and trains users to ignore tips entirely.

**Add a tip only if ALL three hold:**

1. **Hidden value** — invisible or unlikely to be discovered by normal UI exploration (keyboard shortcut, hover/drag/right-click behavior, CLI power, non-obvious workflow). If a visible button/badge/toggle explains itself on screen, a tip about it is spam.
2. **Honest score ≥ 3** on the rubric below. A would-be 1–2 means no tip (rare exception: a truly invisible auto-behavior that saves real pain may ship at 2).
3. **Not already covered** — check `ALL_TIPS` first; if the feature, or its cluster (stats screen, mobile gestures, remote access, diff review…), already has 2–3 tips, update/reword the existing tip in the same commit instead of stacking a near-duplicate.

**Count:** 0 by default; 1 if the gate passes; 2 only for a genuine flagship (score 5). Ship tips in the same commit as the feature. **Never write a tip for:** self-describing UI, visible visual states (spinners, glows, badges), settings toggles that restate their label, behavior users already expect, anything met naturally on the happy path.

**Files:** registry `src/mainview/tips.ts` (`ALL_TIPS` array); i18n keys `tip.<id>.title` / `tip.<id>.body` in `{en,ru,es}.ts`. **Content:** title 3–6 words; body one sentence max ~120 chars — tell the user *what to do*, no fluff; icon = Nerd Font glyph (`\u{XXXXX}`).

**Coolness score (mandatory `score` field, 1–5 where 5 is coolest).** Tips surface highest tier first, random within a tier (see `selectTip` in `tips.ts`). Self-assign the score with this rubric — do NOT ask the user:

- **5** — flagship demo-reel "wow" that sells the product: multi-agent variants, bug-hunter swarm, CoW worktree deps, AI Review, live terminal preview.
- **4** — strong distinctive capability most users will love: agent-driven PRs, command palette, OSC52 clipboard, port auto-allocation, image/large-text paste.
- **3** — useful everyday convenience that is still non-obvious: search operators, right-click open, hover previews.
- **2** — minor convenience or settings toggle. Below the gate — normally no tip.
- **1** — niche/power-user trivia. Never add.

When unsure between two tiers, pick the lower — and below 3 the answer is usually "no tip". Append new tips at the end of `ALL_TIPS`. **Registry hygiene:** if a new tip supersedes/overlaps an older one, delete or merge the old one in the same commit (its `ALL_TIPS` entry + keys in all three locales).

## Keyboard shortcuts

**`src/mainview/keymap.ts` is the single source of truth for app-level keyboard shortcuts.** When you add or change one (a renderer `useGlobalShortcut` binding, a task-switcher key, or a native-menu accelerator users rely on), update its `keymap.ts` entry in the same commit — the registry renders the in-app Keyboard Shortcuts overlay (`KeyboardShortcutsModal`, Help → Keyboard Shortcuts / ⌘/ / ⇧⌘P), the README table, and the website, so an unregistered shortcut is invisible everywhere. `__tests__/keymap.test.ts` guards basic validity; keeping the registry in lockstep with handlers is your discipline. The registry **documents**, it does not dispatch — do not refactor the `App.tsx` handler chain to read from it. Terminal/tmux `⌃B` prefix bindings are not app-level; they live in `src/bun/tmux-config.ts` and render on the overlay's Terminal tab.

## Decision records

Non-obvious architectural decisions, hacks, and workarounds go in `decisions/NNN-short-slug.md` (sequential numbering — check existing files for the next number; descriptive slug like `worktree-branch-cleanup`). They record **why**, not just what, for future agents and humans.

**Create one when you:** relied on undocumented behavior or reverse-engineered internals; chose a non-obvious approach over a simpler one for a specific reason; worked around a dependency bug/limitation; made a decision with trade-offs or known risks.

**Required sections:** 1. Context 2. Investigation (if applicable) 3. Decision (what + where in the code) 4. Risks 5. Alternatives considered. **Keep it short** — 2-4 sentences per section, fits on one screen; link relevant code paths (file + function names). Commit the record together with the code change.

## Agent skills

Configuration the engineering skills (`to-tickets`, `triage`, `to-spec`, `qa`, `improve-codebase-architecture`, `diagnosing-bugs`, `tdd`, …) read to fit this repo.

### Issue tracker

Issues/PRDs live as **tasks on the dev-3.0 Kanban board** (managed via the `dev3` CLI — a task *is* an issue); external GitHub PRs are pulled in as a secondary triage surface. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles map to **dev3 labels** with their canonical names (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`); dev3 statuses/columns stay hook-managed. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `AGENTS.md` is the primary domain/architecture doc (no separate `CONTEXT.md`), ADRs live in `decisions/NNN-slug.md` (not `docs/adr/`). See `docs/agents/domain.md`.

## Test instructions (mandatory for every task)

**Every task must end with a "Test instructions" section in the final message** — a TL;DR the user can follow without reading the conversation above:

```
## Test instructions

1. Go to [place in the app]
2. Click [element] / Do [action]
3. Expected: [what should happen]
```

Rules:
- **Cover the entire task, not just the latest change** — if the task added buttons A, B, then C, verify all three; mark the newest item with `(new)`.
- **Be specific** — exact labels, tab names, menu paths ("Open Settings → General tab → 'Auto-save' toggle"), not "open settings".
- **Keep it short** — one numbered step per thing to verify; what to do + what to expect, no why.
- **Include negative cases if relevant** — e.g. "Click X when Y is empty — expect an error toast, not a crash."
- **Update, don't duplicate** — a new version fully replaces earlier test instructions; always give the full set.

## Commands

```bash
bun run dev          # Main local development flow (build, package, launch locally)
bun run start        # Alternative launch path (reuses existing Vite output)
bun run build        # Build (staging channel)
bun run build:prod   # Build (production channel)
bun run lint         # TypeScript type-check — must pass before committing
```

**HMR / Vite watch is NOT used in this project.** Never run `bun run watch`, `bun run hmr`, or any `vite --watch` flow — the only supported dev loop is `bun run dev`. **Never run `bun run bump`** — versioning is owned by the user, not AI agents.

## CLI exit codes

Public `dev3` CLI exit codes are a documented contract:
- Define them only in `src/shared/cli-exit-codes.ts`; keep every non-zero code unique.
- Do not inline non-zero exit numbers in `src/cli/`.
- Update `docs/cli-exit-codes.md` and `src/cli/__tests__/exit-codes.test.ts` whenever a code is added or changed.

## Architecture

### Task lifecycle glossary

- **Column** — the task's Kanban placement: a built-in `status` plus an optional custom-column ID. Users, hooks, and agents request column changes; the lifecycle machine accepts or rejects them from fresh task state.
- **Runtime** — the actor-owned execution phase (`idle`, `preparing`, `running`, or `tearing-down`), independent of the column. `Task.runtimeState` is only a persisted recovery hint and must be verified against tmux/worktree reality at boot.
- **Activity** — a watcher declared by lifecycle state, such as `mergeWatch` or `prWatch`. Activities deliver findings back through the task mailbox; they never write task status directly.
- **Actor/mailbox** — the per-task FIFO that serializes lifecycle events while allowing different tasks to run in parallel. RPC callers await their own mailbox event and its synchronous effects.
- **Compensating event** — the explicit event dispatched when an `abort` effect fails. The transition table declares the recovery path; the executor must not hide it in ad-hoc catch logic.

Two-process model:

- **Main process** (`src/bun/index.ts`) — runs in Bun via Electrobun APIs (`BrowserWindow`, `Updater`, `Utils`); creates the app window, handles lifecycle.
- **Renderer** (`src/mainview/`) — React app bundled by Vite; entry `main.tsx`, root component `App.tsx`.

### RPC protocol

Renderer ↔ main communicate via **Electrobun's built-in RPC** (IPC bridge); schema in `src/shared/types.ts` (`AppRPCSchema`, channels `bun` and `webview`).

- **Request/response:** components call `api.request.METHOD(params)` (Promise, 2-minute timeout). Handlers live in `src/bun/rpc-handlers/*.ts`, split by domain (`app-handlers`, `settings-config`, `task-lifecycle`, `git-operations`, `tmux-pty`, `notes-labels`, `remote-access`, `port-tunnels`, `scripts`; `shared.ts`/`shared-pure.ts` are cross-domain helpers, not domains). `src/bun/rpc-handlers.ts` is a barrel re-exporter merging them into a single `handlers` object.
- **Push messages:** main sends unsolicited updates via `pushMessage?.("eventName", payload)`; the renderer dispatches them as `CustomEvent`s (e.g., `rpc:taskUpdated`) consumed with `window.addEventListener()`.

### State management

React **`useReducer`**, no external state library. Store in `src/mainview/state.ts`: `useAppState()` wraps `useReducer(reducer, initialState)` — routing, project/task lists, UI flags. Components call `api.request.*` to fetch/mutate, then `dispatch()` reducer actions; push messages trigger listeners that dispatch to keep the UI in sync.

### Renderer asset loading (dev-channel Vite fallback)

On the `dev` channel the main process loads from a running Vite server on `localhost:5173` if it responds, otherwise falls back to bundled assets via the `views://` protocol. The mechanism exists in code, but agents must never run a Vite watch/HMR loop themselves — see the HMR ban in [Commands](#commands).

### Build pipeline

Vite builds `src/mainview/` → `dist/`; Electrobun copies `dist/` into `views/mainview/` for packaging. Config in `electrobun.config.ts`.

### Drag-and-drop files (uploaded into worktree)

WKWebView does not expose native host file paths in drag-and-drop events. Dropped files are **uploaded into the task worktree** (up to 100 MB per file) and pasted as worktree-relative paths. See [decision 036](decisions/036-worktree-uploaded-dnd-files.md).

### Process spawning (`Bun.spawn`)

**NEVER use `Bun.spawn`/`Bun.spawnSync` directly** — always import `spawn`/`spawnSync` from `src/bun/spawn.ts`. macOS `.app` bundles inherit a minimal PATH; we patch `process.env.PATH` at startup (`shell-env.ts` → `index.ts`), but `Bun.spawn` without an explicit `env` option ignores the patch. The wrapper always passes `{ ...process.env, ...opts.env }` so every child process sees the full user PATH (homebrew, nvm, etc.).

### tmux — always go through TmuxClient (MANDATORY)

**Never spawn `tmux` directly — only via the `tmux` client singleton from `src/bun/tmux/`.** The module owns the binary/shim selection (a bare PATH `tmux` may be a different version than the server, which breaks every command — the v1.29.1 ELOOP incident, decision 105), the socket, all `-F` format declarations (`formats.ts`, TAB-separated, one parser), and `dev3-*` session naming (`session-names.ts` — never recompute names inline). A tmux subcommand the client doesn't cover means adding a typed method **plus its unit test** to `src/bun/tmux/client.ts` — not a raw spawn at the call site. Handler tests mock the `tmux` singleton (same pattern as mocking `rpc.ts`); the client's own tests inject a fake spawn. There is deliberately no automated guard for this rule — it is convention, enforced in review (decision 138).

### Agent skill injection

The app auto-installs the **dev3 skill** into agent config dirs (`~/.claude/skills/dev3/`, `~/.codex/skills/dev3/`, …) on every startup. The generated `SKILL.md` files are overwritten on each launch — **never edit them directly**; the template is the `SKILL_CONTENT` constant in `src/bun/agent-skills.ts`. The skill's `allowed-tools` frontmatter controls auto-permitted tools (omitted = no restriction, user's normal permissions apply; `allowed-tools: Bash` = Bash only).

**Feature differences between agents** (hooks, skill variants, CLI flags, integrations) are tracked in [`agent-support-matrix.md`](agent-support-matrix.md) — keep it up to date when adding or changing agent-specific behavior.

## Project scripts

Each project has three lifecycle scripts (free-form shell), configurable in Project Settings (`src/mainview/components/ProjectSettings.tsx`), stored as fields on the `Project` type (`src/shared/types.ts`) in `projects.json`, saved via the `updateProjectSettings` handler (`src/bun/rpc-handlers/settings-config.ts`):

| Field | When it runs |
|---|---|
| `setupScript` | After a new worktree is created for a task |
| `devScript` | On dev-server start (`dev3 dev-server start` or the UI button; runs in a tmux window — see `src/bun/rpc-handlers/tmux-pty.ts`) |
| `cleanupScript` | Before worktree removal after `completed`/`cancelled` (and `archived` once added) |

## Styling & design tokens

All UI colors are **CSS custom properties** (design tokens) in `src/mainview/index.css`, mapped to Tailwind in `tailwind.config.js`. Themes: `dark` (default) and `light` (`[data-theme="light"]` on `<html>`).

**Strict rule: NEVER hardcode hex/rgb colors in components** — use the semantic token classes:

| Token class | Purpose |
|---|---|
| `bg-base`, `bg-raised`, `bg-elevated`, `bg-overlay` | Surface levels (page → panel → card → popup) |
| `bg-raised-hover`, `bg-elevated-hover` | Hover states for corresponding surfaces |
| `text-fg`, `text-fg-2`, `text-fg-3`, `text-fg-muted` | Text hierarchy (primary → muted) |
| `border-edge`, `border-edge-active` | Borders (default / hover) |
| `bg-accent`, `bg-accent-hover`, `text-accent` | Accent color (blue) |
| `text-danger`, `bg-danger` | Destructive actions (red) |

All tokens support Tailwind opacity modifiers (`bg-accent/20`, `border-accent/30`). Need a new color? Add a CSS variable in `index.css` (both themes) + a Tailwind mapping — never inline arbitrary values. **Exception:** `STATUS_COLORS` in `src/shared/types.ts` stay hex — semantic status colors used in inline styles (column headers, card borders, dots), not theme chrome.

### Nerd Font icons in the renderer

The app bundles **JetBrainsMono Nerd Font Mono** (`src/mainview/assets/fonts/`, `@font-face` in `index.css`). Prefer Nerd Font glyphs over SVGs:

```tsx
<span
  className="text-[1.125rem] leading-none"
  style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}
>
  {"\u{F0645}"}
</span>
```

- **Always wrap font-family in single quotes** inside the style object — multi-word font names may not resolve otherwise.
- **Use ES6 `\u{...}` escapes for codepoints above U+FFFF**: the classic `"\uF0645"` silently parses as `"\uF064" + "5"` (only 4 hex digits consumed). Up to U+FFFF, classic `"\uF188"` is fine.
- Browse glyphs at [nerdfonts.com/cheat-sheet](https://www.nerdfonts.com/cheat-sheet). Working examples: `GlobalHeader.tsx` (bug icon `\uf188`), `TaskInfoPanel.tsx` (file-tree icon `\u{F0645}`).

## Internationalization (i18n)

All user-facing renderer strings are localized via `src/mainview/i18n/`; locales: **English** (default, source of truth — defines the `TranslationKey` type), **Russian**, **Spanish**. **Strict rule: NEVER hardcode user-facing strings in components** — use `t()` from the `useT()` hook.

- `useT()` → `t(key)` and `t.plural(baseKey, count)`; `useLocale()` → `[locale, setLocale]`; `statusKey(status)` maps `TaskStatus` → translation key (`"in-progress"` → `"status.inProgress"`).
- Translations live in **domain files** under `src/mainview/i18n/translations/{en,ru,es}/` (`common.ts`, `kanban.ts`, `tips.ts`, `settings.ts`, …); the locale barrels `en.ts`/`ru.ts`/`es.ts` merge them — **never edit barrel files directly**. Non-English locales must satisfy `TranslationRecord` (TypeScript errors if a key is missing).
- Locale persists in `localStorage("dev3-locale")`, same pattern as the theme.

**Adding a string:** add the key to the matching `en/` domain file (e.g., `kanban.ts` for `kanban.*` keys), add translations to the same domain file in `ru/` and `es/`, then use `t("your.key")`.

**Interpolation:** `{variable}` placeholders — `t("dashboard.failedAdd", { error: String(err) })`.

**Pluralization:** suffix convention `_one`, `_few`, `_many`, `_other`; call `t.plural("dashboard.projectCount", count)`. English needs only `_one`/`_other`; Russian needs all four (`"{count} проект"` / `"{count} проекта"` / `"{count} проектов"` / `"{count} проектов"`).

**Adding a locale:** mirror the `en/` domain files under `translations/{locale}/` + a merging barrel satisfying `TranslationRecord` (copy `ru.ts` structure); register in `ALL_LOCALES`/`LOCALE_LABELS` (`i18n/types.ts`) and `translationSets` (`i18n/context.tsx`); add plural rules in `i18n/interpolate.ts` (`getPluralForm`).

**Do NOT translate:** input placeholders that are command examples (`"bun install"`, `"claude"`, `"main"`), terminal output (`term.writeln()`), the app name in breadcrumbs (`"dev-3.0"`).

## Testing

**Framework: Vitest** with `happy-dom` and React Testing Library. Three configs: `vitest.config.ts` (mainview), `vitest.config.bun.ts` (backend), `vitest.config.cli.ts` (CLI).

```bash
bun run test          # Fast — mainview + bun + cli in parallel, excludes 3 slow e2e files (~6s)
bun run test:full     # Everything incl. slow e2e files (~42s, for CI/PR)
bun run test:bun      # Backend tests only
bun run test:cli      # CLI tests
bun run test:watch    # Watch mode
```

Running vitest directly (outside `bun run`): use `bunx vitest run`, not `npx`.

**Local E2E policy:** Do not run the complete E2E suite locally (`bun run test:full` or an equivalent unfiltered command); it is reserved for CI/PR validation. When investigating or verifying a specific behavior, run only the targeted E2E file or test case.

**Always run both `bun run lint` AND `bun run test` before committing** — a commit that breaks type-checking is unacceptable even if tests pass.

**Hard rule — full suite before push/PR:** before `git push`, `gh pr create`, or enabling auto-merge, `bun run test` must be green end-to-end. Running only the test file you edited is NOT sufficient — sibling test files assert against the same components (e.g., `TaskCard.tsx` is covered by both `TaskCard.test.tsx` AND `TaskCardSeq.test.tsx`). Fix failures and re-run until green BEFORE pushing — don't push and watch CI go red.

### Manual UI QA in a browser

**Self-QA UI changes in a browser before review — it's the default.** Any change touching what the user sees can break subtly (layout shift, overflow on one viewport, console error, wrong state render). Drive the running UI, look at a screenshot, check console errors before handing off. **"It's small" is not a reason to skip** — small UI changes slip through the most. Only real exceptions: no visual surface at all, or the UI genuinely can't be brought up. When in doubt, QA it.

With the dev-server running and the project's Port Allocation ≥ 1, the dev app already serves the web UI at `http://localhost:<DEV3_PORT0>/?token=<code>` (`dev3 dev-server status` → `DEV3_PORT0`; see [decision 093](decisions/093-dev-remote-port-from-pool.md)). Otherwise serve it yourself: `dev3 remote --no-tunnel --static-code <code> --port <port>`. Point `agent-browser` at the URL. **Each task must drive its own isolated browser session** — `export AGENT_BROWSER_SESSION="dev3-${DEV3_TASK_ID%%-*}"` — otherwise parallel agents share one global browser and stomp each other's QA. Full recipe: the **`/debug-ui`** skill (`.claude/skills/debug-ui/SKILL.md`; dev-internal tooling, not dev3-shipped).

### Coverage requirements

Overall: **70% lines, 65% branches, 70% functions.** Critical modules need **85% lines, 80% branches**: `state.ts`, `src/shared/types.ts` (helpers), `src/mainview/i18n/`, `src/cli/`, `src/bun/data.ts`, `src/bun/git.ts`, `src/bun/tmux/`, `src/mainview/utils/`. Excluded (bootstrap/wrappers that only make sense in e2e): `src/bun/index.ts`, `updater.ts`, `shell-env.ts`, `spawn.ts`, `src/mainview/rpc.ts`, `main.tsx`.

### What to test

- **Unit (mandatory):** state reducer actions + edge cases, all pure functions/utils/parsers, every RPC handler (happy path + 2-3 error cases), CLI commands (parsing + validation + output), data layer CRUD + corrupt data handling, git operations with mocked spawn, i18n interpolation + pluralization for all locales.
- **Component (mandatory):** all major interactive components — board views, task cards, modals, settings panels. Always `userEvent`, not `fireEvent`. Test behavior, not implementation.
- **E2E (CLI-based):** full lifecycle through CLI + Unix socket against a real app process with tmpdir — task lifecycle (create → move statuses → complete), project CRUD, worktree creation + cleanup, notes CRUD, CLI context auto-detection, concurrent writes (no data corruption).

### Bug fixing workflow — reproduce first

**Always start by writing a failing test that reproduces the bug** (red), then fix the code until it passes (green); commit test + fix together. Exception (rare): the bug genuinely can't be reproduced in a test (OS-specific timing, hardware, unmockable third-party behavior) — default to writing the test first.

### Test writing rules

- One logical assertion per test; no dependencies between tests.
- Mock only external boundaries (git, tmux, fs, Electrobun), not internal modules.
- No `sleep`/timers — use proper async/await.
- Every new feature or bug fix must include tests; PRs that drop coverage below thresholds are rejected.
- Tests live in `__tests__/` directories next to their modules (e.g., `src/mainview/components/__tests__/Dashboard.test.tsx`).

### Mocking Electrobun RPC / providers

Components that import `api` from `rpc.ts` need the Electrobun native module mocked:

```ts
vi.mock("../../rpc", () => ({
	api: { request: { listDirectory: vi.fn(), addProject: vi.fn() /* … */ } },
}));
```

Components using `useT()` must be rendered inside `<I18nProvider>` (import from `../../i18n`).

## Key config files

- `electrobun.config.ts` — Electrobun app config (name, identifier, build copy rules)
- `vite.config.ts` — Vite config (root: `src/mainview`, output: `dist/`)
- `tailwind.config.js` — Tailwind scans `src/mainview/**/*.{html,js,ts,jsx,tsx}`
- `tsconfig.json` — strict mode, ES2020 target, bundler module resolution

## Documentation

Local docs for key dependencies live in `vendor-docs/`: `electrobun/` and `ghostty-web/` (local markdown — read directly), `bun/` (pointer to Bun's `llms.txt` — fetch `https://bun.com/docs/llms-full.txt` for full docs in one request, or see `vendor-docs/bun/README.md`). **Before writing code that touches a dependency, check `vendor-docs/` first** — do not guess APIs from memory; verify against the docs.

## Landing page (GitHub Pages)

The `docs/` directory hosts the **public landing page** served via GitHub Pages at `https://dev3.h0x91b.com/` (custom domain, see `docs/CNAME`; the old `https://h0x91b.github.io/dev-3.0/` URL redirects there). Source: `docs/index.html`; screenshots in `docs/screenshots/`.
