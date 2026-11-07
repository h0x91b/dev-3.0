# Extensions platform: macro plan and status

A living document. Update it when a phase moves; it is the one place that says where the effort stands.
Last updated: 2026-11-07.

## The goal

Prove that a dynamic UI built on Cordis plugins works well and reliably inside dev3, then gradually rebuild
dev3's own surfaces on that runtime, so almost any part of the app can be shipped, replaced or extended as an
extension. This only works if agents can write, debug, see and install extensions on their own, so agent
developer experience is a first-class part of the goal, not an afterthought.

**Cordis** (npm `cordis`) is the plugin runtime this rests on: each plugin gets a context `ctx`, registers what it contributes and uses services the host provides (`ctx.board`), and unloading a plugin removes all of it automatically. React still renders; Cordis tracks who contributed what and for how long. Glossary entry: `docs/glossary.md`.

## Phases

| # | Phase | Status |
|---|---|---|
| 1 | Board views on Cordis: the first real proof | Done; merged to `main` via #2143 (2026-11-07) |
| 2 | Agent DX for writing extensions | Started: `dev3-extensions` skill task (2026-11-07) |
| 3 | Reliability bar: what "works well and reliably" means before migrating more | Partly covered by phase 1 |
| 4 | Migrate dev3 surfaces to plugins, one at a time | Not started; order not decided |

### Phase 1: Board views on Cordis (umbrella PR #2143)

Integration branch `feat/dev3-cordis-board-host`. Child PRs are squash-merged into it, and it goes to `main` once.

Done:

- Cordis `4.0.0-rc.11` pinned exactly; root context, `ctx.board` service, view registry (#2143 base).
- Kanban rewritten as `builtin:kanban` on the contract (#2146).
- Table view (#2145), Tree view (#2157) with Group by epic (#2164) on top of global epics (#2140).
- Attention view with token-query buckets (#2144); `has:pr`, `pr:`, `is:stalled` tokens (#2142).
- Extensions: loader (RPC + blob module + import map), trust and consent, Settings → Extensions, kill switch,
  `DEV3_EXTENSIONS=off`, built-in view toggles, sample extension, `docs/extensions.md` (#2158).
- Switching: filter-row switcher, `V 1–9` / `V V`, command palette, View → Board View, docs/ux (#2159).
- CI green on the umbrella head. The extension path was verified in Chromium, Playwright WebKit 26, and on
  2026-11-07 by Arseny in the desktop app (WKWebView on `views://`).

Closing checklist:

- [x] UX polish of every new screen (better-interface / better-ui pass, zebra rows, 2026-11-07).
- [x] Remove `feat/dev3-cordis-board-host` from `on.pull_request.branches` in `.github/workflows/build.yml`.
- [x] Move the changelog entries to the actual merge date.
- [x] Merge #2143 (Arseny's go, auto-merge on green CI).

Design records: `decisions/2026/10/31/pluggable-board-views-on-cordis.md`,
`decisions/2026/10/31/board-host-cordis-provision.md`,
`decisions/2026/11/01/kanban-board-view-on-the-contract.md`,
`decisions/2026/11/01/board-view-extensions-loader-and-trust.md`.

### Phase 2: Agent DX for extensions

The gaps today, found while verifying phase 1:

1. An agent cannot install an extension: install and trust exist only in the desktop UI, and the remote or
   headless session (where agents run QA) may not install or trust at all.
2. There is no edit → reload loop; a changed bundle needs a reinstall.
3. Load failures and renderer errors are visible only in the UI (status "Failed to load", `console.error`).
4. Outside a dev3 clone there are no types for `ctx.board`; only the prose in `docs/extensions.md`.
5. No recipe for screenshotting one's own view; `/debug-ui` is written for dev3 itself.

Options:

- **A. Skill only.** Cheap, but it would have to teach workarounds (hand-editing trust state) and fixes none of
  1–3.
- **B. Skill plus `dev3 extension` CLI** (recommended): `new <id>` scaffold, `validate <path>`, `dev <path>`
  (link a folder in dev mode after one user approval, reload on change), `status` / `logs <id>`, `types`
  (emit the contract `.d.ts`), and a screenshot recipe through the headless dev server. The skill then teaches
  the commands, not workarounds. Start with the skill, then `dev` and `status`/`logs`.
- **C. B plus a published npm types/SDK package.** Better for outside authors, but a separate release cycle while
  the contract is still moving. Later.

Distribution: dev3 already installs skills into every agent's skill directory on startup
(`src/bun/agent-skills.ts`, how `ask-dev3` ships), so a `dev3-extensions` skill reaches users who never clone
dev3. It must be its own skill file, not part of the dev3 protocol body, which is capped by the Windows command
line limit.

### Phase 3: Reliability bar

Already covered: StrictMode and plugin-dispose tests, an error boundary that falls back to Kanban, the kill switch
and `DEV3_EXTENSIONS=off`, "Restart with extensions off" on crash screens, desktop-only install and trust,
anonymous telemetry (`builtin:<id>` or `third_party`).

Open:

- No sandbox: consent, desktop-only install and the kill switch are the only defences.
- `EXTENSION_API_VERSION` is `1.0.0`; there is no policy yet for when the contract breaks and how extensions
  are told.
- Cordis is a release candidate; moving to 4.0 stable is a deliberate bump that must re-run the runtime tests.
- No measurement yet of runtime cost (load time, re-render cost on large boards) with several extensions.

### Phase 4: Migrating dev3 itself

Not started. The order of surfaces to move onto plugins is Arseny's decision; each move should keep behaviour
identical and land behind the same reliability bar as phase 1.

## Open decisions

- Phase 2 scope (A / B / C) and when it starts.
- The reliability criteria that gate phase 4.
- Which dev3 surface migrates first.
