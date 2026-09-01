# Guard against double-encoded UTF-8 in source text

## Context

The AI Review column's default prompt rendered "worth surfacing â add a short" and
"<1â3 sentence summary>" in the agent's terminal and in Project Settings. Every project on
this build showed it, because the text is `DEFAULT_REVIEW_PROMPT` in `src/shared/types.ts` —
not per-project state.

## Investigation

`src/shared/types.ts` held 46 double-encoded characters: 20 em dashes, 13 degree signs,
10 arrows, one en dash, one ellipsis, one command symbol. `git blame` put all of them in a
single commit, `ec6f01de8c` ("Fix double complete/cancel sound in remote mode", 2026-06-28),
whose parent is clean and whose subject has nothing to do with punctuation — some tool in
that session read the file as UTF-8 and wrote it back as Latin-1, mangling only the lines it
rewrote (193 em dashes elsewhere in the file survived intact). No other tracked text file in
the repo is affected, and neither `projects.json` nor `tasks.json` carries a saved copy.

The reason it survived two months: the result is still valid UTF-8, so nothing fails. The file
compiles, `bun run lint` is happy, every test passes, and a diff review shows the mangled run
as one odd-looking character in an otherwise correct line. Only the rendered prompt gives it away.

## Decision

Repaired the 46 runs in place (byte-level replacement of the six known sequences), and added
`src/bun/__tests__/mojibake-guard.test.ts`: it reads every tracked text file as Latin-1, finds
runs of C2/C3 lead bytes, and reports a run only when decoding it through Latin-1 twice yields
printable text — which leaves genuine Latin-1 characters (degree, section, middot) alone. The
test names the offending file and prints "mangled -> intended" so the fix is mechanical. Its
own patterns are written with `\u` escapes, or the file would trip its own guard.

## Risks

The detector is heuristic: a file that legitimately contains the literal two-character sequence
an em dash mangles into would be a false positive. No such file exists here, and the failure
message makes the call obvious. It scans the whole tree on every backend run — 2.7 s.

## Alternatives considered

A pre-commit hook was rejected: hooks are per-machine and this repo's other text invariants
(decision-record names, UX doc budgets, the agent command-line budget) are all asserted as
tests, so CI catches it for every contributor. Restricting the scan to prompt constants was
rejected too — the same commit mangled 44 characters outside them, and the next one will land
somewhere else.
