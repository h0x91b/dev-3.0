> Partly superseded on 2026-11-21 by `decisions/2026/11/21/task-header-status-items.md`: the status bar is split too, so the legacy-cluster mechanism is gone.

# Task header: the session bar as individual built-in items

## Context

Step 3.3 of the GUI-on-Cordis migration splits the Session/Agent bar (bible §5.1, panel 3) out of its legacy cluster: Find bugs, + Agent, Send later, Hibernate, the scheduled-messages chip and the tmux pane controls. Their three dialogs, the hibernate flow and its busy flag were `TaskHeader` state, used by the bar, by the narrow sheet rows and by the panel's restore control, which is chrome.

## Decision

`src/mainview/task-header/builtin-session.tsx` defines `SESSION_ITEMS` (`builtin:session.*`), registered in bar order in place of the session legacy cluster. The live-session gates are `when` predicates. Hiding was per item here until 3.6 moved it to the host (`task-header-user-layout`): items no longer wrap themselves in `HideableControl`.
- The cross-bar state is one controller, `useTaskSessionController`, called once by `TaskHeader` and passed through the internal header context (`TaskHeaderInternals.session`), like the git branch status. Items, sheet rows and the restore control all call it, and the header renders its `dialogs` once.
- ⚙ worktree settings, restore, help and shortcuts stay host chrome, outside the region.
- On the narrow sheet, Find bugs, + Agent and Hibernate are the session items' sheet form. They now form one session section after the runtime rows, in the bar's order (Find bugs before + Agent), as bible §12.6 asks ("the bars' actions become sheet sections"). Hibernate stays last.

## Risks

The sheet row order changed for tasks with ports, images or artifacts: + Agent and Find bugs now come after those rows, and Find bugs precedes + Agent. `TaskHeader.test.tsx` asserts the new order. The desktop bar and the narrow summary bar are unchanged.

## Alternatives considered

- **A sheet-only sub-group to keep the old interleaved order:** a region only the phone knows about, for a cosmetic order. Rejected by the coordinator.
- **Keeping the dialog state in `TaskHeader` and passing openers:** the hibernate flow would stay in the host, away from the items that own it.
