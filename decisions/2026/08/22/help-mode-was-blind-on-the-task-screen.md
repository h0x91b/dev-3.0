# Help mode was blind on the task screen, and a reachability check could not see it

## Context

PR #1472 shipped a first-run callout whose entire job is to send a newcomer to
help mode. That promise only holds if help mode then explains the screen they are
standing on. The task screen is where a dev3 user spends nearly all their time and
is the least familiar thing in the product — a tmux session with an agent in it.

## Investigation

Driving a virgin instance with help mode on, the task screen produced exactly
three zones: `header.utilities`, `filters.dsl`, `sidebar.active-tasks`. Nothing on
the task's own two toolbars and nothing on the terminal, which is ~80% of the
pixels. Enumerated in the browser rather than by reading, and the DOM agreed:

    ["header.utilities","filters.dsl","sidebar.active-tasks"]

Two independent causes:

1. **`TaskInfoPanel` renders its four bars twice.** The expanded branch carries
   `inspector.context-bar` / `session-bar` / `git-bar` / `runtime-bar` plus the
   `inspector.panel` HelpSpot; the **collapsed** branch — the one a task screen
   opens in, since `dev3-panel-collapsed` defaults to true — duplicated all four
   markup blocks without a single help id. `help.test.ts` stayed green throughout,
   because its reachability check asks "does any file mention this id", and the
   expanded branch mentions all of them. A test that cannot distinguish which
   branch mounted a zone cannot protect the branch users actually see.
2. **The terminal was excluded on purpose, for the wrong surface.**
   `REQUIRED_HELP_SURFACES` documents "the immersive terminal (§5 forbids its
   chrome)" as a deliberate omission. Bible §5 line for *Terminal immersive
   fullscreen* is about that mode — no header, no inspector, one Exit action. The
   ordinary task screen's terminal was never covered by that reasoning, and
   inherited the exemption by name.

## Decision

- The collapsed branch gets the same four `data-help-id`s and the same
  `inspector.panel` HelpSpot as the expanded one (`TaskInfoPanel.tsx`).
- New topic `terminal.task`, mounted on `TaskWorkspacePane`'s root and gated by a
  new `immersive` prop so immersive fullscreen stays chrome-free. It lives on the
  **pane**, not on `TaskWorkspaceView`, because there are two mount sites — the
  first attempt put it on the view and the board route (`ProjectView`, which
  mounts the pane directly) still had no zone. Caught in the browser, not by a
  test.
- New topic `dashboard.ops-board`, chosen per row so the builtin Operations board
  stops borrowing the git project-row copy. Its whole prior explanation was the
  subtitle "Code-driven tasks · no git".
- `help.test.ts` now also reads ids out of `data-help-id={…}` expressions, so a
  conditional zone counts as the literals it can resolve to.
- A new guard renders `TaskInfoPanel` in its default collapsed state and asserts
  all five zones. Proven by mutation: deleting one id fails it, and `help.test.ts`
  does not.

## Risks

- The terminal zone covers the whole pane, so in help mode a click anywhere in the
  terminal opens the card instead of reaching the terminal. That is what help mode
  does to every zone, and it ends on `Esc`.
- `terminal.task` is now in `REQUIRED_HELP_SURFACES`; a future refactor that moves
  the pane's root will fail the drift test rather than silently drop the zone.
- The exemption comment in `help.ts` and the bible's §5.4 coverage-floor sentence
  now have to stay in agreement about which terminal is exempt. Both were edited
  in this change; nothing enforces that they stay aligned.

## Alternatives considered

- **A second first-run callout on the terminal.** Rejected by rule: bible §10
  lists "two callouts on one screen" as a reject, and the `?` callout already
  fires on the task screen. The right answer was to make the thing the callout
  advertises actually pay off.
- **A dismissible one-line strip above the terminal.** Permanent-ish chrome on the
  one surface the manifest keeps chrome-free, for a fact most users need once.
- **Making the reachability check per-branch** (parse JSX, know which branch is
  default). Far more machinery than the concrete guard, and it would still not
  have found the terminal, which had no id anywhere.
