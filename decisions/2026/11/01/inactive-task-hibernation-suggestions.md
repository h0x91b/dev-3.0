# Inactive-task hibernation suggestions

## Context

A silent inactivity policy can surprise users and destroy terminal history they still value. Review requested one grouped suggestion after 24 hours of real task inactivity, enabled by default, with a configurable 30-minute timed confirmation.

## Decision

The host owns a single pending batch, snoozes and deadlines (`auto-hibernate-scheduler.ts`); a renderer must acknowledge displaying the React dialog before its countdown starts. Any dialog interaction permanently holds the batch; Not now gives each task another full inactivity threshold. Both explicit and timed responses recheck the current policy, task state, real input/output activity and terminal layout inside the lifecycle actor.

Viewing, pointer motion, scrolling and focus neither reset inactivity nor exempt a task. Eligibility requires exactly one live agent pane across all windows/native terminals; live servers, peer instances and unreadable activity prevent suggestions. Timed hibernation skips the cwd-wide process reaper, preserves files and conversations, and explains the result with a localized toast.

## Risks

Timeout confirmation still discards managed terminal scrollback. The dialog states this explicitly, focuses Not now, and stops its timer on interaction; extra panes are protected even when quiet. Pending batches and snoozes live in memory; restarting the host abandons prior consent and requires a freshly displayed suggestion. Unknown activity starts a new observation window.

## Alternatives considered

Keeping silent hibernation was rejected in review because users need visibility before losing a terminal. A dialog per task creates a stack of interruptions; one selection dialog handles a batch. A client-owned timer could fire independently in several windows or after stale activity; host deadlines and serialized lifecycle guards provide one authority.
