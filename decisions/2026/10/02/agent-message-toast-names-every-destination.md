# The agent-message toast names every destination

## Context

The violet `dev3 message` toast was one invisible whole-card button. With the traffic beta on it opened Agent traffic focused on the receiver; users expected the sender and could not tell where a click would go. The payload carried no sender task id at all (`fromSeq` only), so the sender was unreachable from the renderer.

## Decision

`AgentMessagePayload` gains `fromTaskId`, `fromVariantIndex`, `toVariantIndex` (`announceAgentMessage` in `src/bun/scheduled-message-scheduler.ts`). `toast.tsx` gains two generic slots: `contextParts` (source line as links — `#seq` never truncates, only the title does) and `actions` (labelled buttons), both siblings raised above the card button, never nested, swallowing pointerdown so they never start a swipe, and dismissing after they run. `App.tsx` builds: underlined sender and recipient links, one never-wrapping action row — paper-plane `#N` (sender) · traffic icon + `Agent traffic` · inbox `#N` (recipient), full role names in `aria-label`/`title`, and only the traffic label may truncate (a wrapped row made the toast a line taller, which the user rejected) — and keeps the card click on Agent traffic (receiver without the beta). The card's destination is fixed when the toast is raised, because its accessible name (`clickLabel`) now says where it goes; a beta switched off mid-toast falls back to the receiver because traffic no longer exists. Each end is looked up at click time (`openAgentToastEnd`): gone → info toast, outside the active columns → board card, never resumed. Project names appear only when the two ends live on different boards.

Driving it exposed a pre-existing race in `ProjectView`: switching projects keeps the view mounted, so for one commit `tasksStatus` still said `ready` about the previous board and any cross-board `taskDetailId` read as "no longer on this board". `readyBoardKey` now ties `ready` to the board it describes.

## Risks

Three actions plus two links is the busiest toast in the app; it is acceptable only because this toast is already capped at one visible copy. The old "beta switched on mid-toast reaches traffic" behaviour is gone on purpose — the label would have lied. A payload queued before this change has no `fromTaskId`; its sender stays plain text.

## Alternatives considered

Five other layouts were mocked (sender chip, sender-as-title, card-to-sender plus icon, hover-revealed actions, two zones). All but hover-reveal kept an unlabelled whole-card target; hover-reveal hid the actions. Making the card inert was rejected by the user — traffic and sender are the most frequent destinations.
