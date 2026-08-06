# The journal proof splits durability from isolation

_Cite this record by slug — `journal-proof-splits-durability-from-isolation` — never by number or path._

## Context

`test:native-registry-e2e` went red once on Windows (run 31100808763, attempt 1, commit
45a1d68b3) on the single line `FAIL - bravo journal holds only bravo's output`. The check
was one boolean over two unrelated properties — the session's own marker being present AND
the other session's marker being absent — and printed nothing else, so the log could not say
whether the registry had leaked one session's output into another's journal (a correctness
defect on the only platform with no tmux) or the marker simply had not been flushed yet.

## Investigation

The host records a chunk into the `JournalWriter` **before** it fans the same bytes out to
clients (`host.ts`, the `terminal.data` callback). The test observed `BRAVOMARK` on the live
stream first, so those bytes were in the writer's memory by construction — the failure could
only be memory→disk→read, or a real leak. The test then slept a fixed 400 ms against a 150 ms
debounce timer on a loaded 2-core runner, and read through `readJournalTail`, which reports
"unreadable" and "nothing persisted" as the same empty tail. The commit under test touched no
registry file, and a strict descendant (ab86cf4ff, run 31102170635 attempt 1) ran the same
proof green 19 minutes later.

## Decision

`lifecycle.bun-e2e.ts` now treats the two properties differently. **Durability** ("a session's
own output reaches its journal") is eventual, so it is polled to a `JOURNAL_DURABILITY_BUDGET_MS`
ceiling instead of slept at. **Isolation** ("a journal never holds the other session's output")
is a safety property: it is re-evaluated on every poll and ends the loop on the first violation,
so waiting can never sit on top of a leak and wait it out of sight. `check()` gained an
explain-on-failure callback; the journal failure names which of the four causes fired
(leak / marker never produced live / journal unreadable / never flushed) and quotes the chunk
count, file size, read error and journal tail.

## What this change does and does not claim

The mechanism behind the red was never named, so **this change does not claim to remove the
flake.** Polling durability instead of asserting it once may well be the cause on Windows —
that is a hypothesis, not a repair. What it does claim: the check could not distinguish two
different failures and now can, and the next occurrence is diagnosable from the CI log alone
(which half broke, plus the journal evidence behind it). If it recurs after this lands, the
log will finally say which half.

## Risks

The budget is a ceiling, not a delay, so a green run costs nothing — but a genuine durability
regression now takes up to 10 s to report instead of failing at 400 ms. Accepted: the proof
already runs minutes of packaging around it, and a fixed sleep is what produced an
uninvestigable red in the first place.

An isolation check cannot pass over zero observations: "no foreign marker" is vacuously true
on an empty or missing journal, so it is conjoined with the session's OWN marker being present.
An empty journal fails the check, and both cases are mutation-proved.

## Alternatives considered

- **Raise the fixed sleep.** Same defect at a different threshold, and still one bit of output.
- **Split into two checks without polling.** Fixes the diagnosis, keeps the timing flake.
- **Retry the read inside `readJournalTail`.** A production change with no evidence behind it
  yet; the new failure message will say whether a Windows sharing violation is really happening.
