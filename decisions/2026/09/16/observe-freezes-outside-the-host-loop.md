# Observe freezes outside the host loop

## Context

The September 15 wake-time freeze left host timer delays but no renderer-loss record. A renderer last seen hidden can stop reporting when it becomes visible, and a watchdog sharing the blocked host loop cannot sample that host while it is blocked.

## Investigation

The existing artifact recovery watchdog treats late host ticks conservatively and only judges visible renderer beats; it is a recovery policy, not an independent observer. Native WebKit logs identify the owning host and WebContent PID, whereas process parentage and highest CPU do not reliably attribute a renderer.

## Decision

`DEV3_DEBUG=1` opts a macOS desktop session into `freeze-diagnostics.ts`, an independent Bun worker with bounded local records and three-second native stack samples. `window-manager.ts` supplies per-window desktop beats and native focus/close events; renderer beats add geometry and sparse animation-frame progress, and `shell-env.ts` permits only this diagnostic variable through the otherwise blocked `DEV3_*` prefix. The worker ships as a self-contained resource directory and uses bounded Node `execFile` calls with absolute system binary paths, explicit environment and a temporary cwd; it cannot import the application spawn wrapper and its dependencies from the packaged directory.

## Risks

An observer scheduling gap is recorded as sleep-or-scheduling-unknown and gets a 20-second grace period; this is not native power-state detection. Samples are local/private, may contain paths and unsymbolicated JIT frames, and can fail under OS restrictions; missing attribution never falls back to an arbitrary WebContent process. Each command is time/output bounded, captures are limited to three per launch with a five-minute cooldown, and five bounded sessions are retained; the artifact recovery policy is unchanged.

## Alternatives considered

Adding more host-loop logging would miss a permanently blocked host; adding synchronous native bridge calls would reintroduce the risky tracing path explored in the earlier artifact investigation. A separate daemon, automatic restart, and changing user preferences are unnecessary for this diagnostic scope. Native power notifications or renderer operation tracing can be considered after reviewing the new captures, if the stack evidence remains insufficient.
