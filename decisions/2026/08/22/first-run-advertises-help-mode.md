# First run advertises help mode instead of guiding the user, and the tour ban is lifted

## Context

Nobody on the team could reach dev3's first-run state: every home directory has projects,
tasks and settings in it. `DEV3_HOME` became a real redirect in
[scoped-qa-app-instance](../21/scoped-qa-app-instance.md), so first run was finally walked
rather than imagined — `bun run dev --qa=virgin`, driven in a browser end to end.

## Investigation

Two observations killed the design the task was written around.

**The flow completes.** Empty home → dashboard → add a local repo → open the board → write one
task → agent running in its own worktree. No dead end anywhere, and even the cliff we expected
is already handled: pointing a harness at a binary that does not exist produces a pre-flight
`Agent not found: <cmd>` with the install command and a retry, plus a red panel in
Settings → Agents and a `Not installed` mark in the launch picker.

**A new install is never at zero projects.** First boot writes the builtin Operations virtual
project, so `projects.length > 0` is always true and the dashboard's own zero-projects empty
state (`Dashboard.tsx`) is unreachable code. The first screen is a board with one system
project, an empty Velocity Cockpit link on top, and ~60% void.

Also corrected against the starting inventory: adding a **new** project writes nothing into the
user's repository. `migrateProjectConfig` (`src/bun/repo-config.ts`) returns early on
`if (!hasSettings) return`, and `.gitignore` is only touched through `saveRepoConfig` — so that
side effect belongs to an upgrading user, not a new one. Verified twice (observed, then in code).

So first run is not a rescue mission. It is an explaining problem, and the only teaching channel
dev3 has is help mode.

## Decision

Help mode stops waiting to be discovered.

1. **The header `?` wears a dismissible callout** on the screens a new user lands on —
   `dashboard`, `project`, `task`, `project-settings` (`HELP_ATTRACTOR_SCREENS`,
   `GlobalHeader.tsx`) — until help mode is opened once or the callout is closed. The flag is
   `GlobalSettings.helpModeDiscovered`, written in one place in `App.tsx`, so the shortcut, the
   menu, the palette, a HelpCard link, the button itself and the callout's × all count. One-way.
   **The explanation sits beside the control, not in the middle of a screen** — Arseny rejected a
   first draft that carried it as a plate inside the dashboard panel: the centre of a screen
   belongs to that screen's own content.
2. **A first-run strip takes the stats card's slot** in `ActivityOverview.tsx` while no git
   repository exists, and hands it back when one does. A heading and one sentence — deliberately
   not a card, for the same reason.
2a. **Help entry points that already existed but could not be seen.** All three big modals (New
   Task, Launch, Add Project) already carried a `HelpSpot` with a registered topic; it rendered as
   a 12px `text-fg-3` Nerd-Font info-circle that reads as a decorative bullet, which is why it was
   reported as missing. Now accent-tinted at rest globally, and larger in those three modal
   headers. `Spaces` was worse than invisible: its only zone lived on `SpacesRail`, which does not
   exist until a space does, so the hardest concept in the product was unexplained exactly on a
   first run. The topic now also mounts on the `New space` button.
3. **Empty states stop lying.** `kanban.noTasksHint` ("use the button below") now renders only in
   To Do, which is the only column with a New Task button; the others say tasks arrive on their
   own. On a board with no tasks at all, To Do explains the first task and names `Save & Start`.
4. **No tips at zero tasks** (`KanbanBoard.tsx`) — a card about hovering a task card is noise to
   a user who has none.
5. **`Add project` is covered in help mode** (`dashboard.add-project`), added to
   `REQUIRED_HELP_SURFACES`. Help mode previously highlighted the chrome and skipped the first
   screen's own primary action, which made the promise false at the first place it is made.
6. **The blanket ban on multi-step tours is lifted** from bible §5.4 and §10, at the user's
   explicit instruction. Nothing here is a tour; the ban is gone so the class can be argued on
   merit later. Rules recorded in bible §5.4a.

## Risks

- **The attractor is desktop-inline only.** On narrow viewports the `?` lives in the action
  sheet, and the highlight does not follow it there. Help mode itself stays reachable, so this is
  a discoverability gap on touch, not a dead feature — worth closing separately.
- **Lifting the tour ban removes a refusal we used to have.** The next feature with a complex
  flow can now ask for a tour and there is no blanket rule to point at, only §5.4a's "earn it
  against these four moves first".
- **The flag rides `GlobalSettings`**, so it is per installation, not per person on a shared
  machine — the same trade-off every other setting there makes.
- **The attractor animation loops** while undiscovered. Kept long-cycle and mostly at rest, and
  behind `motion-safe:`, but it is a resting animation on the header, which the project otherwise
  reserves for the icon families named in AGENTS.md.

## Alternatives considered

- **A "first steps" checklist card** with live checkmarks (add project → create task → launch).
  Rejected by the user in favour of the smaller shape; it also sits one step from the tour the
  doctrine had banned, which would have needed the amendment anyway.
- **A full-screen welcome destination.** Rejected: global nav already carries 8 destinations
  against a documented budget of 7, and a screen that exists only until the first repo is added
  is the worst possible use of that slot.
- **Fix only the proven defects** (copy bug, empty states, tips, `Save`/`Save & Start` roles) and
  decide the shape later. Rejected as the whole change, though its defect list was folded in —
  except the `Save` / `Save & Start` button roles, deliberately left alone: that is a modal
  hierarchy question on a surface every user meets, not a first-run one, and the first-task copy
  names the right button in the meantime.
- **Suppressing the Operations project when it is the only one**, so the existing empty state
  could fire. Rejected: a project that silently vanishes reads as data loss (§10's own reasoning
  for keeping a locked sensitive project visible).
