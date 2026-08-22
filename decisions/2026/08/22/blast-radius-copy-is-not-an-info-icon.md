# Blast-radius copy is not an info icon

## Context

First-run onboarding work (seq 1623). Five personas were written from the 60 open issues plus the
maintainer's own account of who installs this. Over half the userbase turned out to be corporate
engineers pointing dev3 at a work monorepo: strong in their own language, thin on the Linux/git
plumbing dev3 is built out of. Their first question is not "how do I create a task" — it is *what
will this program write to my repo, and what will it push*.

Two manifest rules blocked answering it in the place the question is asked.

## Investigation

- `docs/ux/PRODUCT_UX_BIBLE.md` §10 `onboarding_help` routed **all** explanatory content into help
  mode and rejected standing affordances outside it. Read literally, a sentence in the Add Project
  dialog saying "your checkout is never modified" is the banned permanent `(i)`.
- §4 and §9 both declared the nav budget as **≤ 7 top-level destinations** while `main` has shipped
  **8** since `stats` landed (`dashboard`, `project`, `task`, `project-terminal`, `settings`,
  `project-settings`, `changelog`, `stats`). A budget already violated by `main` is not a budget:
  the previous planning pass derived a false "we are over budget, therefore the sandbox cannot be a
  project" from it, and reached the wrong shape.
- The evidence for the corporate persona is asymmetric on purpose. There is no
  "I could not get started" issue in the tracker, because someone who cannot answer the blast-radius
  question closes the app and files nothing. The only trace of that failure is its absence.

## Decision

Two edits, both in `docs/ux`:

1. **§4 / §9 and `ux-architecture.yaml`:** the destination budget is **8, and fully spent** — a
   ninth replaces one. The number now matches the shipped list, so the next agent has to
   consolidate instead of arguing that the number is stale.
2. **§10, new row** `onboarding_help outside help mode` — two carve-outs, and only two:
   **(a)** the first-run callout §5.4a already specifies (anchored, dismissible, once-only), and
   **(b)** *blast-radius copy* — a standing, quiet, non-dismissible plain-sentence statement at the
   top of a dialog that acts on the user's own files or remotes, saying what dev3 writes, where, and
   what it pushes. Not an `(i)`, not a warning banner, and never hedged.

The first application is `AddProjectModal.tsx` (git kind): worktrees live under `~/.dev3.0`, each
task gets its own branch, the user's checkout and current branch are untouched, and nothing reaches
a remote until the user or the agent they launched pushes.

## Risks

- The carve-out is a hole in a rule whose whole point is "no chrome outside help mode". It is
  narrowed by two conditions that are hard to fake: the dialog must **act on the user's own files or
  remotes**, and the copy must be a **verifiable statement of consequence**, not an explanation of
  the UI. A dialog that merely does something complicated does not qualify.
- Standing copy that drifts out of date is worse than none — it becomes a false promise about
  someone's monorepo. The statement is deliberately short and tied to facts enforced elsewhere in
  the codebase (`git.ts` worktree paths, `assertGitTask`), so a change to those breaks tests near
  the claim.
- `PRODUCT_UX_BIBLE.md` went 122 → 123 KB in `ux-docs-budget.test.ts`. Compaction ran first and only
  returned ~200 bytes (§5.4a's walk-through evidence, duplicated in its own record); the rest of the
  file's bulk is §10 reasoning that exists nowhere else. `TOTAL_BUDGET_KB` stayed at 309.

## Alternatives considered

- **A HelpSpot on the dialog title.** Already there, and it is the reason this was filed as a gap
  rather than a bug: help behind a click is help the frightened user does not click. They are
  deciding whether to hand the program their employer's repo, and an `(i)` reads as chrome.
- **Show it once, then remember.** Rejected on the persona: the question returns with the second
  repo, and it is the same three sentences either way. Once-only is right for advertising a control
  (§5.4a), wrong for a consequence.
- **A `warning`-token banner.** Rejected — nothing is wrong. Amber on a safe, correct action trains
  the user to ignore amber where it does mean something.
- **Leave §10 as written and put the copy in help mode only.** That is the status quo, and it is what
  the missing-issue asymmetry argues against: it protects the manifest and loses the user.
