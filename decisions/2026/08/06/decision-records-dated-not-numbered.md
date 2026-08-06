# Decision records are dated directories, not sequential numbers

## Context

`AGENTS.md` told agents to name a record `decisions/NNN-short-slug.md` with "sequential numbering — check existing files for the next number". That instruction cannot work in this repo: every task runs in its own worktree branched off the same `main`, so two agents writing a record on the same day both see the same highest number and both take it. On 2026-08-05 tasks Seq 1422 and Seq 1426 each picked `207`, caught only because a coordinator happened to be watching both.

## Investigation

Measured on `origin/main`, not predicted:

- 369 records, 216 distinct numbers. **98 numbers were shared by 2–7 records** (`084` ×6, `164` ×7, `172` ×7); 251 of 369 files shared their number with someone. The number had not been a unique key for a long time — the `205` pair was one of ninety-eight.
- **All 369 slugs were unique.** Zero collisions, with no coordination whatsoever, over the whole history — exactly the property the changelog convention was designed for (`change-logs/YYYY/MM/DD/`: one file, unique descriptive slug, explicitly to avoid parallel-agent conflicts).
- Citations: 108 by full path (1 dangling) and **352 bare `decision NNN` mentions, 234 of which (66%) pointed at an ambiguous number**. Nothing parses decision filenames programmatically — every reference is prose.

So the number delivered neither uniqueness nor stable citation. Its only surviving job was a rough chronological sort.

## Decision

Records live at `decisions/YYYY/MM/DD/slug.md` — the same dated-directory shape as `change-logs/`, for the same reason. The slug is the identity; the date only sorts. Records are cited by path or slug, never by a bare number. Documented in `AGENTS.md` § Decision records, mirrored in `docs/agents/domain.md` and the `ask-dev3` skill text (`src/bun/agent-skills.ts`).

**All 369 existing records were moved in one pass**, each into the directory of the day it was first committed (`git log --diff-filter=A`). Arseny took this call explicitly, with the citation cost in front of him. The mitigation is [`decisions/README.md`](../../../README.md): a frozen table mapping every old `NNN-slug.md` name to its new path, so a citation in a merged PR body, a GitHub issue, git history or an agent's memory still resolves in one grep. All in-repo path citations were rewritten in the same change, including 20 slugless ones (`decisions/137`) resolved by hand against their surrounding context.

**The rule is asserted, not just written down.** Documentation is exactly what failed here — `AGENTS.md` carried the "check existing files for the next number" instruction the whole time the archive accumulated 98 shared numbers. `src/bun/__tests__/decision-record-names.test.ts` fails when a record sits outside `YYYY/MM/DD/slug.md`, when two records share a slug, or when the `README.md` map loses a row or points at a file that is not there; the 369 legacy names are frozen in `__tests__/fixtures/legacy-decision-records.ts` (same shape as the `WINDOWS_SCOPE_PATHS` list). The guard also protects what prose cannot: a future agent copying the shape of the files it sees, because habit follows the majority, not the doc.

## Risks

- **Bare `decision NNN` prose citations (352 of them) no longer resolve by filename at all.** They were already ambiguous in 234 cases; now they resolve only through the `README.md` map. This is the real price of the rename and it was accepted knowingly.
- **Branches in flight that add a numeric record fail the guard when both land.** Four exist today: PR #1177 (`179-pr-babysitter-…`), PR #444 (`032-…`, `033-…`), PR #1283 (`221-…`). The fix is one `git mv` each — an unmerged filename has no external citations yet.
- Records are reached by topic, not by date, so the tree costs a `rg --files` where a flat directory cost an `ls`. Weighed and accepted for consistency with `change-logs/`.
- Two records written the same day with the same slug would still collide; the slug is descriptive enough that this has never happened in 369 records, and the guard fails loudly if it does.

## Alternatives considered

- **Flat `YYYY-MM-DD-slug.md`** — same collision-freedom, one directory, topic search stays a single `ls | grep`, and 30% of days hold exactly one record so the tree buys little. Recommended and rejected by the user in favour of matching `change-logs/` exactly.
- **Keep numbers, make collisions harmless** — that was the status quo, and it produced 234 ambiguous citations.
- **Drop the number without a date** — loses chronology entirely.
- **Random or content-hash suffix** — uniqueness the slug already provides, plus unreadable names.
- **Leave the 369 old records numbered** — the original plan, on the grounds that renaming breaks external citations that cannot be updated. Overruled deliberately; the `README.md` map is what makes the overrule survivable.
