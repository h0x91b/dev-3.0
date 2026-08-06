# 213 — The downloadable Windows build is the tree the proof launched, and the installer is a known gap

## Context

CI built the real Windows package, proved the extracted app reached a window and shut
down cleanly, and then discarded everything but JSON
(`211-windows-proof-post-merge-not-pull-request.md` moved that proof post-merge).
Windows is the only platform with no local machine in the loop, so the app was
simultaneously provably launchable and impossible for anyone to obtain.

The Windows build emits two candidate deliverables, and neither is usable as-is:

| Candidate | Openable by a human | Ever launched by anything |
|---|---|---|
| `canary-win-x64-dev-3.0-canary.tar.zst` | **no** — Windows `tar.exe` cannot read zstd; this job ships electrobun's `zig-zstd.exe` precisely because of that | yes, by `verify:win-app-launch` |
| `canary-win-x64-dev-3.0-Setup-canary.zip` (self-extracting installer) | yes | **no** |

Shipping both and documenting which was which would have handed a human the unproven
one and kept the proven one as decoration.

## Decision

**The file the run summary tells a human to open must be a file the proof launched.**
Enforced by mechanism, not by wording:

1. `scripts/verify-windows-app-launch.ts` honours `DEV3_WINDOWS_APP_UNPACK_DIR` and
   extracts into that durable directory instead of a temp workspace it deletes, then
   records it as `retainedUnpackDir` in `windows-app-launch-proof.json`. The uploaded
   bytes are the launched bytes, not an equal-looking re-extraction.
2. The `windows-app-archive` job uploads that directory as `windows-app-<sha>`
   (30-day retention, `if-no-files-found: error`, and deliberately **no** `if:` — a
   failed launch proof must publish nothing; `if: always()` would read as debugging
   convenience and start handing out builds that never reached a window).
3. `scripts/windows-download-summary.ts` renders the run summary **from** the launch
   proof, reading `bundleRoot` and `desktopExecutableRelativePath` out of it, and throws
   when `retainedUnpackDir` is absent. It structurally cannot advertise an executable
   nothing started.

The upload lives in the reusable `windows-conpty-package.yml`, so release runs emit the
same artifact — behaviour reaching `release.yml` without editing it.

## Known gap — the installer is built and never launched by anything

`dev-3.0-Setup-canary.exe` (wrapped as `…-Setup-canary.zip`) is produced by every
Windows build and **no test, proof or job has ever run it**. This artifact deliberately
does not hand it out. That is a gap, not a design nicety: the installer is the path a
real Windows release would eventually ship, so the unproven thing is the thing with a
future. Anyone finding it in the build output must not assume it was vetted.

Closing it means growing `verify:win-app-launch` a second target — install to a real
location, launch from there, uninstall — which is a separate decision with its own CI
cost, not an oversight to be fixed in passing.

## Risks

- The extracted tree is ~400 MB uncompressed; the upload adds minutes to a job with a
  35-minute budget. If it ever crowds the budget, shrink the retention or the job, not
  the launched-bytes property.
- `package:win-archive` passes `--env=canary` and a human gets that build as-is. Safe
  under a **condition**, not as a property: today the channel is a name only
  (electrobun's `naming.ts` suffixes artifact and app names and records a `build.json`
  field, nothing else) and no Windows `update.json` is published for any channel.
  Re-examine when real channel semantics land.
- A stale build in the artifact list reads as current. Retention is 30 days rather than
  the 90-day default for that reason; an expired build is re-run on its commit, not lost.

## Alternatives considered

- **Upload the `.tar.zst` and the installer `.zip`, documenting which was proved.**
  Rejected: it hands a human the unproven binary. Documenting a gap does not close it.
- **Upload the archive with `zig-zstd.exe` beside it.** Meets the property literally, but
  gives a human two unsigned binaries and a two-step command line to start one app, and
  the decompressor is itself unproven. Worse for the same guarantee.
- **Grow the launch proof a second target so the installer could ship.** Deferred, see
  the known gap above.
