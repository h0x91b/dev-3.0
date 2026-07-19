# iOS board watchdog kill: per-comparison ISO8601DateFormatter construction

## Context

TestFlight builds 3 and 7 were killed on a real iPhone ~1-10s after opening a project board
(`0x8BADF00D` scene-update watchdog: "exhausted real (wall clock) time allowance of 10.00 seconds").
The symbolicated main thread (build 7 dSYM, `dev3-2026-07-19-193540.ips`) showed
`ProjectBoardView.columnStepButton → ProjectBoardProjection.columns → TaskOrdering.terminalRecencyPrecedes
→ ISO8601DateFormatter.init → ICU DateFormatSymbols locale copy`.

## Investigation

Three compounding defects: (1) `TaskOrdering.date()` constructed a fresh `ISO8601DateFormatter`
per call — each init copies ICU locale tables — and sort comparators call it up to 4x per
comparison, O(n log n) times, on the main thread; (2) `ProjectBoardView.columns` was a computed
property re-running the whole projection on every body access (pager, plus two chevron step
buttons per column header); (3) the formatter's default options reject the fractional-second
timestamps the desktop always emits (`2026-07-19T10:42:27.949Z`), so every parse returned nil —
all that cost bought nothing, and recency sorting silently fell back to seq/id. A ~78-task
Completed column x dozens of projection re-runs exceeded 10s on device; M-series simulators
absorb it, which is why sim QA never caught it.

## Decision

`TaskOrdering.date()` now parses with two cached `Date.ISO8601FormatStyle` values (fractional
first, plain fallback) — Sendable value types, no ICU init per call, and fractional timestamps
actually parse. `ProjectBoardView` stores `columns` as a `let` computed once in `init`
(all inputs are immutable stored properties, so per-view-value caching is semantically identical).
Regression test: `ProjectBoardModelsTests.fractionalSecondTimestampsParse` uses the production
timestamp format; earlier tests passed only because they used second-precision timestamps.

## Risks

Completed/cancelled columns and readiness ordering change on upgrade — they are now genuinely
recency-sorted where they previously fell back to seq order. This matches the intended design and
the web UI.

## Alternatives considered

`nonisolated(unsafe) static let ISO8601DateFormatter` (documented thread-safe) — works but keeps
an unsafe escape hatch and the fractional-seconds parse bug would need `.withFractionalSeconds`
anyway; `FormatStyle` is Sendable by construction. Precomputing sort keys (Schwartzian transform)
— unnecessary once parsing is cheap; revisit only if boards grow by orders of magnitude.
