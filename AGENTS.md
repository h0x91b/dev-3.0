# AGENTS.md

This file provides guidance to AI coding agents when working with code in this repository.

> **Note:** `CLAUDE.md` is a symlink to this file (`AGENTS.md`) so all agents (Claude Code, Cursor, Codex, …) read the same instructions. Both files appearing changed in a diff is expected.

## Response style

**This repo does not impose one.** Shape, language and register of your replies belong to your harness's output style and the user's own instructions. The English-only rule applies solely to text written **into** the repo (see [Language policy](#language-policy)), never to replies.

## What is this

A **terminal-centric project manager** — iTerm2 meets Kanban. Desktop app for managing multiple AI coding agents and terminal tools across tasks and projects. Built with **Electrobun** (not Electron), React 19, Tailwind CSS, Vite; runtime is Bun. Supports macOS and Linux (Windows planned).

Key idea: each project is a git repo; each task gets its own **git worktree** + **terminal** running inside **tmux** with a preconfigured command (e.g., `claude`).

- Full product concept + implementation status tracker: [`concept.md`](concept.md)
- Design system (colors, typography, components, glass morphism, themes): [`DESIGN.md`](DESIGN.md) — follow it for any UI code
- UX architecture manifest (object model, navigation, surfaces, action taxonomy, placement rules, complexity budgets): [`docs/ux/PRODUCT_UX_BIBLE.md`](docs/ux/PRODUCT_UX_BIBLE.md) + machine-readable [`docs/ux/ux-architecture.yaml`](docs/ux/ux-architecture.yaml) — the canonical UX reference for where features live and which surface owns which action

## UI/UX work — always plan with `/ux-principal` (MANDATORY)

Before designing or implementing **anything** UI/UX-related — a new screen, surface, button, modal, toolbar action, navigation change, any visible control — you MUST first invoke the `/ux-principal` skill. It reads the UX manifest, classifies the feature, decides placement, navigation, action hierarchy, token roles, and complexity budget, and produces an implementation brief. Never add UI controls ad hoc — that is exactly how toolbar/inspector button creep (the project's top UX anti-pattern) happens.

If the manifest is stale or missing, regenerate it with `/ux-create-manifest`. Keep `docs/ux/` updated whenever surfaces or the action taxonomy change.

**Screenshot the zone before you plan it.** Driving the current UI beats reasoning from memory about what is on screen — same tooling as the mandatory QA pass afterwards, see [Manual UI QA in a browser](#manual-ui-qa-in-a-browser-mandatory).

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

## No deprecation — ever (MANDATORY)

**This project does not deprecate things; it replaces them.** No `@deprecated` marker, no compatibility shim, no "the old path still works for now", no dead branch kept alive for callers that haven't migrated. The moment something is obsolete, delete it and rewrite **every** caller in the same change. Backward compatibility inside the codebase is not a goal — a full in-place refactor is.

If the rewrite feels too large to finish now, that is a signal to narrow the change, not to leave a deprecated stub behind: half-migrated code with two ways to do one thing is worse than either version alone.

**The one carve-out is on-disk state**, where other installed versions of the app read the same files — there [On-disk data layout](#on-disk-data-layout--hard-invariants-mandatory) governs and its N-2 readability requirement wins. That is a data-format promise to other *processes*, not a deprecation policy for code.

## Parallelism — prefer TeamCreate, within limits

When spawning agents for research, investigation, or parallel work, **prefer `TeamCreate` if your harness exposes it** — team members run as independent peers with full tool access and show up as real peers in the dev3 UI.

Pick the mechanism by what is actually available and how wide the fan-out is:

- **`TeamCreate`, up to 5 members** — the default for multi-agent work. Above 5 the team view becomes unreadable in the GUI, so never exceed it.
- **Wider than 5, or a deterministic multi-stage pipeline** — use `Workflow` (or plain `Agent` fan-out) instead of stuffing more members into a team. Breadth belongs in a workflow, not in the team panel.
- **`Agent`** — correct when `TeamCreate` is not in your toolset at all, for a sub-agent spawned by a team member for its own internal sub-task, or for one-off delegation that doesn't need peers.
- **No delegation** — work so trivial (single file read, single grep) that `Read` / `Grep` / `Glob` beats any agent.

Do not fake a team when the tool is missing, and do not skip delegation just because `TeamCreate` is absent — fall back down the list.

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

### Committing

- **Commit immediately after each logical unit of work — messages in English only.** Don't wait to be asked. Do NOT `git push` automatically — the user decides when to push.
- **Always commit `.claude/` directory changes** (e.g., `settings.local.json`) — they are modified automatically during agent sessions and are part of your session.

### GitHub CLI (`gh`)

The repo is owned by the personal **`h0x91b`** account; the dev machine also has `h0x91b-wix` configured. Before `gh` commands against this repo:

```bash
gh auth switch --user h0x91b 2>/dev/null || true
```

(No-op for collaborators without that account.)

**PRs are squash-merged.** Always pass the strategy flag: `gh pr merge --auto --squash <branch>` — a bare `gh pr merge --auto` fails non-interactively.

### Rebase before push / PR

Before pushing a PR branch or running `gh pr create`, rebase on the live base first: `git fetch origin main && git rebase origin/main` (resolve conflicts before continuing). Keeps PRs conflict-free and CI honest.

### Task completion

**Preservation gate (mandatory):** Never move a task to `completed`, and never request completion approval, while the task's work exists only in a disposable worktree. Completion is allowed when either the result is safely preserved in the destination the task requires — commonly a pull request merged into `main`, but it may be an external file, task note, shared artifact, or another explicit destination — or the user explicitly asks to complete the task. A local commit, passing tests, or an open/unmerged pull request is not enough by itself. If the required destination is unclear or the work is not safely preserved, keep the task open and ask the user.

## Changelog policy

**Every code change gets a changelog entry file** (avoids merge conflicts between parallel agents).

**Path:** `change-logs/YYYY/MM/DD/<type>-[<NN>-]<short-slug>.md` — type prefixes: `feature-`, `fix-`, `refactor-`, `docs-`, `chore-`.

**The `YYYY/MM/DD` is the expected PR merge date, not the start date.** If the task spans days, move (rename) the entry before opening/merging the PR so it matches the actual merge day (with auto-merge, normally the day you open the PR) — the changelog UI groups by ship date.

**Content:** plain text, 1-3 sentences, no frontmatter/headers, one paragraph max.

Rules:
- Include the changelog file in the same commit as the code change.
- Slug must be unique and descriptive enough that parallel agents don't collide.
- **Feeding the update popover** (only `feature-` entries really compete for its slots):
  - **`Short:` line — mandatory for `feature-`:** first line `Short: <≤6 words, no trailing period>`, then a blank line, then the content. It drives the popover's "what's new" preview, while the full first sentence still drives the Changelog screen. `fix-` entries add one when user-visible; otherwise a crude fallback is derived.
  - **Optional two-digit `NN` right after the type** (`feature-00-foo`) ranks which features win the top `MAX_POPOVER_FEATURES` slots before the rest roll into "+N more": `00` = most prominent (demo-reel "wow"), higher = lower, omitted = mid-pack (priority 50). Type is still parsed from the first dash. Rank honestly (reuse the tips coolness rubric) and push dev-only/internal features to a high number so they never eat a user-facing slot. Numbering `fix-`/others is pointless — they only contribute a count.
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

**Files:** registry `src/mainview/tips.ts` (`ALL_TIPS` array); i18n keys `tip.<id>.title` / `tip.<id>.body` in `{en,ru,es}.ts`. **Content:** title 3–6 words; body one sentence max ~120 chars — tell the user *what to do*, no fluff.

**The 1–5 coolness rubric lives on the `TipScore` type** in `src/mainview/tips.ts` — read it there when scoring, and keep it there when it changes. Append new tips at the end of `ALL_TIPS`. **Registry hygiene:** if a new tip supersedes/overlaps an older one, delete or merge the old one in the same commit (its `ALL_TIPS` entry + keys in all three locales).

## The `ask-dev3` skill

`ask-dev3` is the feature router that teaches users how things are done in dev3 (its content is the `ASK_DEV3_SKILL_CONTENT` constant in `src/bun/agent-skills.ts`, auto-installed into every agent's skill dir on startup). It is a **curated map, not a changelog** — most changes do not touch it. If a change introduces or alters a **feature that changes user-facing behavior or a non-obvious workflow** (a new flow, a renamed/moved surface a user story references, a changed default), **consider updating `ask-dev3` in the same commit** so the map does not drift. Skip it for internal refactors, bug fixes, and self-explaining UI. When in doubt, leave it — the user curates additions deliberately.

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

## Telling the user how to check the work

**No mandated block and no fixed heading** — fit it into whatever shape your output style gives you. What must reach the user is the content: enough for them to see the change working without re-reading the conversation.

- **Cover the whole task, not just the last change** — if the task added buttons A, B, then C, all three get a step; mark the newest `(new)`.
- **Be specific** — exact labels, tab names, menu paths ("Settings → General → 'Auto-save' toggle"), commands. Not "open settings".
- **One step per thing to check** — what to do, what to expect, no why.
- **Include the negative case when it matters** — "Click X with Y empty — expect an error toast, not a crash."
- **Replace, don't append** — the latest version supersedes earlier ones; always give the full set, never a delta.

## Commands

```bash
bun run dev          # Main local development flow (build, package, launch locally)
bun run start        # Alternative launch path (reuses existing Vite output)
bun run build        # Build (staging channel)
bun run build:prod   # Build (production channel)
bun run lint         # TypeScript type-check — must pass before pushing
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
- **Draft** — a task the user explicitly marked unfinished ("Save as draft"). A property of the task (`Task.draft`), not a column and not a runtime phase: it lives in To Do, `idle`, with no worktree. No activation path may start it — the lifecycle machine rejects the move, so the UI affordances are only mirrors. The opposite of a *scratch* task (no prompt, launched immediately). Promotion to an ordinary task is one-way; see [decision 180](decisions/180-draft-tasks-lifecycle-enforced-one-way.md).
- **Hibernated** — a property of the task (`Task.hibernated`), not a column and not a runtime phase. The task keeps its column and its worktree; its agent, tmux session and dev server are destroyed to reclaim memory, and it sinks below every live P4 while refusing column changes. Waking is explicit and manual. It is the counterpart of *draft*: a draft never started and has no worktree; a hibernated task started, and everything it produced is intact. See [decision 184](decisions/184-task-hibernation-property-not-runtime-phase.md).
- **Compensating event** — the explicit event dispatched when an `abort` effect fails. The transition table declares the recovery path; the executor must not hide it in ad-hoc catch logic.
- **Peek** — a read-only observation of another task's terminal (`dev3 peek`): pane summary plus a bounded text tail. It never focuses, writes, resizes, or takes ownership, and it never classifies the peer's state — the caller reads the tail. Invisible from inside the observed task, and the observed task does not have to cooperate. See [decision 199](decisions/199-peek-read-only-coordination-glance.md).
- **Freshness granularity** — whether a reported last-output time describes one pane or the whole window. Native reports `pane`; tmux reports `window`, because tmux has no per-pane activity variable. Always carried next to the time so a reader knows how precise it is, never smoothed over.

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
| `bg-accent`, `bg-accent-hover`, `text-accent`, `hover:text-accent-emphasis` | Accent color (blue) — `-hover` for fills, `-emphasis` for text/icon hover |
| `text-danger`, `bg-danger` | Destructive actions (red) |

All tokens support Tailwind opacity modifiers (`bg-accent/20`, `border-accent/30`). Need a new color? Add a CSS variable in `index.css` (both themes) + a Tailwind mapping — never inline arbitrary values. **Exception:** `STATUS_COLORS` in `src/shared/types.ts` stay hex — semantic status colors used in inline styles (column headers, card borders, dots), not theme chrome.

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

**Framework: Vitest** with `happy-dom` and React Testing Library. Three configs run as three independent processes: `vitest.config.ts` (renderer), `vitest.config.bun.ts` (backend), `vitest.config.cli.ts` (CLI).

```bash
bun run test          # renderer + backend + cli in parallel, minus 3 slow e2e files (~6s)
bun run test:full     # everything incl. slow e2e (~42s) — CI/PR only, not local
bun run test:bun      # backend only
bun run test:cli      # CLI only
bun run test:watch    # watch mode
```

**Everything else about testing here — which config covers what, what a change needs covered, house style, mocking Electrobun RPC and `useT()`, reproducing flakes, coverage expectations — is the [`/verify-changes`](.claude/skills/verify-changes/SKILL.md) skill.** Load it when writing or fixing tests. The gates below apply whether or not you read it.

### Verification gates (MANDATORY)

Two gates, escalating. Committing itself has no gate — commit freely, verify before the work leaves the machine.

1. **Before `git push`** — `bun run lint` plus the tests covering what you touched. A push that breaks type-checking is unacceptable even if the tests pass.
2. **Before `gh pr create`, before enabling auto-merge, and again after any rebase** — the **full** `bun run test`, green end-to-end. Only the file you edited is NOT sufficient: sibling test files assert against the same components (e.g. `TaskCard.tsx` is covered by both `TaskCard.test.tsx` AND `TaskCardSeq.test.tsx`), and a rebase pulls in code your run never saw. Fix and re-run until green BEFORE opening the PR — don't open it and watch CI go red.

### Manual UI QA in a browser (MANDATORY)

**A green suite does not verify a visual surface.** Any change touching what the user sees can break subtly — layout shift, overflow on one viewport, console error, wrong state render. Drive the running UI, look at a screenshot, read the console before handing off. **Being a small change is not a reason to skip it** — small UI changes slip through the most. Only real exceptions: no visual surface at all, or the UI genuinely cannot be brought up. The full recipe (serving the app, the per-task isolated browser session, `agent-browser` usage) is the [`/debug-ui`](.claude/skills/debug-ui/SKILL.md) skill.

**Screenshots are taken in streamer mode — always.** The developer's real accounts, emails, and paths are live in the app, and any screenshot can end up in a PR, an issue, or a recording. Append `&streamer=on` to the app URL — it blurs account emails/labels, orgs, home-dir paths, tunnel URLs, and the remote-access QR (see [decision 161](decisions/161-streamer-mode-css-blur-masking.md)). The only exception is a task about verifying those unmasked values: capture the minimum needed and say so.

## Key files

Open the file itself rather than trusting a paraphrase — this list exists so you know it is there.

- `electrobun.config.ts` — Electrobun app config (name, identifier, build copy rules)
- `vite.config.ts` — Vite config (root: `src/mainview`, output: `dist/`)
- `tailwind.config.js` — Tailwind scans `src/mainview/**/*.{html,js,ts,jsx,tsx}`
- `tsconfig.json` — strict mode, ES2020 target, bundler module resolution
- `src/shared/types.ts` — `AppRPCSchema`, `Task`/`Project`, `STATUS_COLORS`
- `src/bun/rpc-handlers.ts` — barrel indexing every `rpc-handlers/*.ts` domain
- `src/mainview/state.ts` — the reducer: every action and state field the UI has
- `src/mainview/index.css` — design tokens, both themes
- `src/mainview/keymap.ts` — every app-level keyboard shortcut
- `src/bun/agent-skills.ts` — `SKILL_CONTENT`, the skill text shipped to agent config dirs
- `src/shared/cli-exit-codes.ts` — public CLI exit-code contract
- `.github/workflows/` — what CI actually runs (incl. the sharded test job)
- `decisions/` — 280+ records of why non-obvious things are as they are; grep before assuming

## Documentation

Local docs for key dependencies live in `vendor-docs/`: `electrobun/` and `ghostty-web/` (local markdown — read directly), `bun/` (pointer to Bun's `llms.txt` — fetch `https://bun.com/docs/llms-full.txt` for full docs in one request, or see `vendor-docs/bun/README.md`). **Before writing code that touches a dependency, check `vendor-docs/` first** — do not guess APIs from memory; verify against the docs.

## Landing page (GitHub Pages)

The `docs/` directory hosts the **public landing page** served via GitHub Pages at `https://dev3.h0x91b.com/` (custom domain, see `docs/CNAME`; the old `https://h0x91b.github.io/dev-3.0/` URL redirects there). Source: `docs/index.html`; screenshots in `docs/screenshots/`.
