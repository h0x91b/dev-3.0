# tmux dependency audit

Reproducible, classified inventory of every remaining production tmux dependency,
plus a deterministic check that fails when a new **unclassified** one appears.

Roadmap item **INT-008** (parent Seq 1141 → Seq 1251). This is **tooling and
documentation only** — it never removes, renames, wraps, or refactors tmux code.
Existing production imports and callers are read-only inputs.

## Files

| File | Role |
| --- | --- |
| `audit.config.json` | **The manifest.** Hand-maintained: scan boundary, taxonomy, classification rules, and per-file overrides. Edit this. |
| `scanner.ts` | Pure, cross-platform scanner: enumerates tracked files, applies the boundary, extracts stable tmux signals + fingerprints. |
| `inventory.ts` | Builds the classified inventory from the manifest + a live scan. Shared by the generator and the check. |
| `generate.ts` | Regenerates `inventory.json` + `inventory.md`. Fails if anything is unclassified. |
| `inventory.json` | **Generated.** Full machine-readable inventory (per-file classification + fingerprint). |
| `inventory.md` | **Generated.** Concise human summary: baseline counts + per-category tables. |
| `__tests__/tmux-audit.test.ts` | The deterministic check (runs in `bun run test` via the CLI vitest project). |

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

## Maintaining it

1. Edit `audit.config.json` (add an override or a rule; adjust the boundary).
2. Regenerate: `bun src/cli/tmux-audit/generate.ts`.
3. Commit `audit.config.json`, `inventory.json`, and `inventory.md` together.

The check (`bun run test`) fails when:

- a scanned production file has tmux signals but no classification (**new unclassified dependency**);
- the committed `inventory.json` is out of sync with a fresh scan (a new/removed tmux token, or a reclassification — run the generator);
- an override points at a path that no longer carries tmux signals (**stale entry**);
- a file hides tmux grammar without the literal token and is not classified.

## Cross-platform

Pure and OS-agnostic: paths are normalized to forward slashes, identities are
content-based, and the only external call is `git`. Verified on macOS/Linux; the
path handling is Windows-safe.
