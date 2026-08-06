# 167 — tmux inventory is advisory, not a PR gate

## Context

The tmux dependency audit (roadmap INT-008) shipped with live repository
assertions in `src/cli/tmux-audit/__tests__/tmux-audit.test.ts`, so the committed
`inventory.json` acted as an exact CI contract. Because a file's fingerprint is
the multiset of every literal `tmux` token it contains, a comment, a test, a
legitimate backend-identity string, a deletion, or two parallel merges all forced
a regenerate — failing otherwise healthy PRs on bookkeeping alone.

## Investigation

The assertions checked four different things at once: manifest completeness
(unclassified files, hidden grammar, stale overrides, taxonomy validity) and
snapshot equality against `inventory.json`. Only the first group says anything
about the repository being understood; the second is pure artifact freshness.
None of it constrains runtime behavior — tmux is still the production default and
the native migration is unaffected.

## Decision

The full live scan is now an explicit manual command, and no repository-state
assertion runs in `bun run test` or required CI.

- New `src/cli/tmux-audit/verify.ts` holds the rules as pure functions:
  `collectManifestProblems`, `collectSnapshotDrift`, `entryIdentities`,
  `formatProblems`.
- `generate.ts` is the single audit command. Default mode scans and regenerates;
  `--check` scans and verifies without writing, adding snapshot-drift detection.
  Both reject unclassified dependencies, hidden grammar, unknown taxonomy values,
  and stale overrides.
- `__tests__/tmux-audit.test.ts` keeps only deterministic unit tests over
  fingerprints, the boundary, classification resolution, and the verification
  rules (fed by fixtures, never a live scan).
- Scanner, classifier, generator, `audit.config.json`, `inventory.json`, and
  `inventory.md` are unchanged and were **not** regenerated — the check was
  already clean when enforcement moved, so no drift is being hidden.

Run the audit at tmux-removal milestones and before CUT-005 / CUT-006.

## Risks

An inventory that nobody runs goes stale between milestones, and a genuinely new
tmux dependency can now land unnoticed. Accepted: the inventory is a deletion map
for planning, not a safety barrier, and the milestone runs are where it is read.

## Alternatives considered

- **Keep the gate, loosen the fingerprint** (ignore comments/tests): still exact
  bookkeeping, just with a fuzzier and more surprising failure mode.
- **Auto-regenerate in CI and commit** — bot commits on every PR; explicitly out
  of scope.
- **Scheduled CI job / separate workflow** — new always-on infrastructure for an
  artifact consulted a handful of times; out of scope.
