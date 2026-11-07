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
| 2 | Agent DX for writing extensions | Skill shipped (`dev3-extensions`, 2026-11-07); `dev3 extension` CLI not started |
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

Done:

- `dev3-extensions` agent skill, installed into every agent's skill dirs on startup (`src/bun/agent-skills.ts`).
  It carries the contract itself, so it works without a dev3 clone: manifest, a working template, `ctx.board`,
  Cordis traps, install and trust, a scoped-QA screenshot recipe, and a symptom → cause table. Tests pin it to
  `BoardService` and the manifest validator so it cannot drift. Verified by a blind run (a fresh agent with only
  the skill wrote, installed, screenshotted and broke an extension on a scoped instance).
- Settings → Extensions links to `docs/extensions.md`, which tells authors without a clone where the skill comes
  from.

The gaps today (status after the skill):

1. An agent cannot install an extension on a real dev3: install and trust exist only in the desktop UI, and the
   remote/headless session refuses both. Workaround in the skill: a scoped QA home, where the agent writes the
   trust record itself. Never on the real `~/.dev3.0`.
2. Edit → reload works only on a scoped instance (copy `index.js`, reload the page); a real install needs a
   reinstall per change.
3. Load failures are visible only in the UI and the console, and not uniformly: an undeclared view id unloads
   the extension with no console line (`enforceDeclaredViews` in `plugins.ts`), and the board shows no notice for
   it. `agent-browser errors` misses the console lines; `agent-browser console` has them.
4. Outside a dev3 clone there are no types for `ctx.board`; the skill and `docs/extensions.md` carry the prose.
5. Screenshot recipe: closed for the in-clone case (scoped QA, in the skill). The no-clone case has no way to run
   a throwaway instance yet, and no released build with extensions existed to try it against on 2026-11-07.
6. A reload drops the browser on the dashboard (no board in the URL), so every QA loop costs a click back.

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

- Whether the `dev3 extension` CLI (option B) starts next, and in which order (`dev` + `status`/`logs` first).
- The reliability criteria that gate phase 4.
- Which dev3 surface migrates first.
