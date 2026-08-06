# tmux dependency audit

Reproducible, classified inventory of every remaining production tmux dependency.

**Advisory, not a PR gate.** The full live scan runs on demand via one command
(below), at tmux-removal milestones and before **CUT-005 / CUT-006** — not on
every pull request. Inventory bookkeeping is not a runtime safety invariant, and
gating CI on it blocked unrelated work
(see [decision 167](../../../decisions/2026/07/25/tmux-inventory-advisory-not-gating.md)).

Roadmap item **INT-008** (parent Seq 1141 → Seq 1251). This is **tooling and
documentation only** — it never removes, renames, wraps, or refactors tmux code.
Existing production imports and callers are read-only inputs.

## Files

| File | Role |
| --- | --- |
| `audit.config.json` | **The manifest.** Hand-maintained: scan boundary, taxonomy, classification rules, and per-file overrides. Edit this. |
| `scanner.ts` | Pure, cross-platform scanner: enumerates tracked files, applies the boundary, extracts stable tmux signals + fingerprints. |
| `inventory.ts` | Builds the classified inventory from the manifest + a live scan. Shared by the generator and the check. |
| `generate.ts` | **The audit command.** Full live scan; regenerates `inventory.json` + `inventory.md`, or verifies with `--check`. |
| `verify.ts` | Pure verification rules (manifest problems, snapshot drift, report formatting). |
| `inventory.json` | **Generated.** Full machine-readable inventory (per-file classification + fingerprint). |
| `inventory.md` | **Generated.** Concise human summary: baseline counts + per-category tables. |
| `__tests__/tmux-audit.test.ts` | Pure unit tests only — fingerprints, boundary, classification, verification rules. No live scan. |

## What it detects

Detection is file-level by the literal token `tmux` (case-insensitive). In this
repository that is a **complete** signal: every tmux command flows through the
`TmuxClient`/`src/bun/tmux/` adapter or the bundled `tmux` binary, all of which
carry the literal token. A secondary high-precision grammar signal (`send-keys`,
`capture-pane`, `split-window`, …) enriches fingerprints and, via
`findHiddenGrammarFiles`, guards the completeness invariant (no tmux grammar may
hide in a file without the literal token outside the adapter's own tests).

## Scan boundary

- **Tracked files only** (`git ls-files`).
- **Excluded** (build/vendor/self, plus binary assets by extension): see
  `boundary.excludeDirs` / `excludeExtensions` / `excludePaths` in the manifest.
  The audit's own directory is excluded so it never inventories itself.
- **Historical** (`change-logs/`, `decisions/`): counted as known references but
  **not** inventoried or checked — append-only ship history and immutable ADRs are
  never edited to remove tmux.

## Classification

Every inventoried file gets: `category`, target `roadmapItem`, `depth`
(`deep-internal` adapter · `caller` · `surface` · `test` · `isolation`),
`dependencyKind` (`active` behavior vs `reference`-only mention), a `consumer`
description, and a `deletionPrerequisite`. See the tables in `inventory.md`.

## Stable identity (no churn on line moves)

Each file's identity is its content **fingerprint** — a hash of the order-independent
multiset of tmux tokens — plus its classification. Reordering or moving lines does
**not** change the fingerprint, so it never churns the inventory. Adding or removing
a tmux token (a genuinely new dependency, or a deletion) does change it, forcing a
regenerate + reclassify.

## Running the audit (manual)

One command performs the full live scan:

```bash
bun src/cli/tmux-audit/generate.ts            # scan + regenerate the artifacts
bun src/cli/tmux-audit/generate.ts --check    # scan + verify only, writes nothing
```

Both modes exit non-zero when:

- a scanned production file has tmux signals but no classification (**new unclassified dependency**);
- a file hides tmux grammar without the literal token and is not classified;
- an entry uses a category / depth / kind / roadmap item that is not in the taxonomy;
- an override points at a path that no longer carries tmux signals (**stale entry**).

`--check` additionally fails when the committed `inventory.json` differs from a
fresh scan (a new/removed tmux token or a reclassification).

**When to run it:** at tmux-removal roadmap milestones and before **CUT-005** and
**CUT-006** — not per pull request. `bun run test` covers only the pure unit tests,
so ordinary work never has to regenerate the inventory.

To update it: edit `audit.config.json` (add an override or rule; adjust the
boundary), run the generator, and commit `audit.config.json`, `inventory.json`,
and `inventory.md` together.

## Cross-platform

Pure and OS-agnostic: paths are normalized to forward slashes, identities are
content-based, and the only external call is `git`. Verified on macOS/Linux; the
path handling is Windows-safe.
