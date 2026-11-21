# Extensions platform: macro plan and status

A living document. Update it when a phase moves; it is the one place that says where the effort stands.
Last updated: 2026-11-21.

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
| 3 | Reliability bar: what "works well and reliably" means before migrating more | Partly covered by phase 1; versioning policy decided |
| 4 | Migrate dev3 surfaces to plugins, one at a time | In progress: internal foundations done (2026-11-21); Settings and the task header frame on their slots; header items next |

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
3. Load failures are visible only in the UI and the console. Every load failure now logs
   `[extensions] <id> failed to load`, and a board whose picked view belongs to a failed extension says so with a
   notice instead of silently showing Kanban. `agent-browser errors` misses the console lines; `agent-browser
   console` has them.
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
anonymous telemetry (`builtin:<id>` or `third_party`). Every slot has a dispose test: `plugins/__tests__/slot-dispose.test.ts`
finds the slots by importing the app, fails on one it does not know, points to each surface's `[dispose]` test, and
runs one registry case per slot (all share `SlotRegistry.register` today, so the cases are a tripwire for an override).
Every slot also has a crash-escape row: `plugins/__tests__/slot-crash-escape.test.tsx` throws from each callback a
contribution hands the host and checks that the surface stays up and the guard logged it.
Performance budgets are tests: `board-perf-budget-e2e.test.tsx` (CI and `test:full` only, ~10 s) (2400 cards and a 2400-row sidebar: at most one
subscription per slot, and a change in a slot a row does not read re-renders no row), `task-header-perf-budget.test.tsx`
(one subscription per header region, none to other slots) and `plugins/__tests__/extension-load-budget.test.ts`
(100 extensions through `syncPlugins`). They assert counts; their wall-clock ceilings only catch an order-of-magnitude regression.

Open:

- No sandbox: consent, desktop-only install and the kill switch are the only defences.
- `EXTENSION_API_VERSION` is `1.1.0`. Policy decided (`decisions/2026/11/21/gui-plugin-slots-and-api-versioning.md`):
  minor per additive slot, service or manifest kind; major on any incompatible change (removal, rename, signature,
  type or semantics), after which extensions whose `engines.dev3` no longer matches show as incompatible and stay
  off, with a migration note in `docs/extensions.md`. It stays `1.1.0` through the internal migration track.
- Cordis is a release candidate; moving to 4.0 stable is a deliberate bump that must re-run the runtime tests.

### Phase 4: Migrating dev3 itself

Planned on 2026-11-21 (coordinator task seq:2526): `decisions/2026/11/21/gui-plugin-slots-and-api-versioning.md`.
Two slot kinds (replace, contribution), add-only for third parties, built-ins register through the slot call
that will become public. **Internal first:** every surface moves onto slots with built-ins only and no new public API (foundations:
app root, generic slot registry and host; then Settings and the four task-header bars in parallel, including the
user's header layout; then commands, context menu, dock panels, replace slots for sidebar/home/destination bodies,
terminal contributions). **Then the opening track** exposes slots and `ctx.*` services to third parties one kind
at a time, each a public PR with a version bump, docs, example and skill update. The app shell and terminal
renderer stay host-owned. Each move keeps behaviour identical.

**Progress.** The internal foundations are in `src/mainview/plugins/`: the app root (`root.ts`, slots declared
with `defineAppSlot`), the generic `SlotRegistry` (`slot-registry.ts`; board views run on it), the runtime that
guards every slot (`runtime.ts`), `<SlotHost>` for replace slots (the board uses it) and `<SlotItems>` for
contribution slots. Global Settings and the Project Settings tab bodies render through the internal `settingsSections` slot
(`src/mainview/settings-sections/`, `decisions/2026/11/21/settings-sections-slot.md`; built-ins only). The task header
draws its four bars from the internal `taskHeader` slot (`src/mainview/task-header/`), one built-in item per control
(`decisions/2026/11/21/task-header-status-items.md`). The ⇧⌘P palette lists the
internal `commands` slot (`src/mainview/commands/`, `decisions/2026/11/21/commands-slot.md`); each command runs itself. Destination
bodies (Sessions, Stats, Changelog, Agent traffic, Home) sit on the internal `destinationBodies` replace slot (`src/mainview/destination-bodies/`,
`decisions/2026/11/21/destination-body-slots.md`), the built-in as the only option. The task view's Active Tasks
sidebar sits on the internal `sidebar` replace slot (`src/mainview/sidebar/`, `decisions/2026/11/21/sidebar-slot.md`),
wide-only as before. The file explorer beside a terminal (task pane and Repo) sits on the internal `terminalCompanion`
replace slot (`src/mainview/terminal-companion/`, `decisions/2026/11/21/terminal-companion-slot.md`). Terminal links
(file paths, OSC 8, `dev3://`, tap targets) come from the internal `terminalLinks` contribution slot
(`src/mainview/terminal-links/`, `decisions/2026/11/22/terminal-link-providers-slot.md`). Passive
glyphs after a terminal window tab's name come from the internal `terminalTabDecorations` contribution slot
(`src/mainview/terminal-tab-decorations/`, `decisions/2026/11/22/terminal-tab-decorations-slot.md`). The public
`contributes` generalisation (plan item 0.4) waits for the opening track.

**Opening-track preconditions.** Before any contribution slot opens to extensions:
- A render crash of an extension's item must be reported into that extension's failure state, so its Extensions
  row shows the reason (today the item only vanishes).
- A page-shaped slot (settings sections) must place built-ins before extensions by origin, not by numeric `order` alone.
- The extension guard rescans every item of every slot on each slot change (`enforceDeclaredItems` in
  `plugins/runtime.ts`), so loading grows superlinearly (indicative, one dev laptop, 2026-11-22: 100 extensions ~25 ms, 400 ~300 ms). Before slots
  open widely, check only the changed slot, or index items by owner.
- Before `taskMenu` opens, a crashed submenu should show the one-line slot notice instead of an empty flyout
  (today it falls back to nothing, logged; a crashed phone sheet just closes).
- Before `terminalCompanion` opens, the terminal must survive a companion swap (load, unload or crash); for example the
  host owns the terminal node and portals it into the companion. Today any swap remounts it: the PTY survives, but
  client scroll, selection and focus are lost (`decisions/2026/11/21/terminal-companion-slot.md`).

## Tech debt

- **Built-ins on the public contract only.** For now a built-in slot item may use internal modules (`api`,
  hooks) behind its slot registration (the record's placement rule). End state: every built-in runs only on
  public `ctx.*` services, like `builtin:kanban`. Pay it down when a public service covers what a built-in
  reads, in the same PR; it does not block opening a slot kind. Open until the last built-in is off internals.

## Open decisions

- The order of `dev3 extension` CLI commands (`dev` + `status`/`logs` first is the proposal); it starts
  with Phase 4's opening track, when public host services exist.
- The reliability criteria that gate Phase 4's opening track (the internal track is not gated by them).
- The order inside Phase 4 beyond Settings and the task header.
