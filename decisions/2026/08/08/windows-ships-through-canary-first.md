# Windows ships through the canary channel only, unsigned, and the first install is the launched tree

## Context

Windows has been packaged on every in-scope merge to `main` since
`windows-proof-post-merge-not-pull-request.md`, and the packaged app provably reaches a window
and dies cleanly. None of it reached a human. The output was a 30-day CI artifact behind a
GitHub login: not attached to a release, not in the update bucket, not installable by anyone who
was not looking at a workflow run. Arseny asked why Windows builds for minutes and appears
nowhere. It appeared nowhere.

Two facts set the shape of the answer, and both are his:

1. **Canary first, deliberately** — every Windows-specific surprise should surface where the
   stakes are low.
2. **There is no Windows code-signing certificate and there will not be one.** An unsigned build
   is the target, not a stopgap. Nothing here may be designed around buying one.

## Investigation

The gap was narrower than it looked. `getPlatformPrefix()` in `src/bun/updater.ts` already
returns `win` for `process.platform === "win32"`, and `electrobun build --env=canary` on Windows
already emits `canary-win-x64-update.json` plus `canary-win-x64-dev-3.0-canary.tar.zst`. What was
missing was a publisher: `CANARY_PLATFORMS` listed four platforms, `canary-publish.yml` had four
caller jobs, `create-release-artifacts.sh` branched on `macos` and `linux`, and no
`release-build-windows.yml` existed.

The launch log of the Windows job on run 31257371545 also produced the finding that ordered the
work. The packaged canary build's **runtime** channel was `stable` — `getAppVersion` returned
`{"channel":"stable","buildChannel":"canary"}` — because the then-global `CANARY_FEED_AVAILABLE
= false` collapsed any canary preference, so it fetched `stable-win-x64-update.json` and logged
`HTTP 403`.

That constant is **gone**: #1310 (Seq 1443) replaced it with `canaryPublishesFor(os, arch)`,
derived from `CANARY_PLATFORMS` itself so publishing and availability cannot drift. **That makes
the `win-x64` entry added here the single switch that unlocks the channel on Windows** — which is
the intended design, and also the reason the ordering below is written down rather than left to
whoever merges next.

Two candidate first-install files exist, and they are not equal:

| Candidate | Openable on a stock Windows box | Ever launched by anything |
|---|---|---|
| `canary-win-x64-dev-3.0-canary.tar.zst` | **no** — `tar.exe` has no zstd; the bundle ships `zig-zstd.exe` for exactly this reason | yes, extracted then launched |
| `dev-3.0-Setup-canary.zip` (self-extracting `.exe`) | yes | **no — no job has ever run it** |
| the extracted tree, zipped | yes | yes, this is the tree that reached a window |

## Decision

**Windows publishes to canary and only canary, and the human-installable file is the tree the
launch proof spawned.**

- `CANARY_PLATFORMS` gains `{ os: "win", arch: "x64" }` (`src/shared/canary-publish.ts`). The
  token is `win`, not `windows`: it names electrobun's build folder, its artifact prefix, and the
  manifest key `getPlatformPrefix()` fetches, so one string has to serve all three.
- New `.github/workflows/release-build-windows.yml`, shaped like its macOS and Linux siblings,
  with one caller: `build-win-x64` in `canary-publish.yml`, gated on `windows-proof` like every
  other publisher. **`release.yml` gets no Windows caller** — an unsigned build does not belong
  in the feed ordinary users poll.
- `scripts/create-release-artifacts.sh` grows a `win` branch **and an OS allowlist**. The
  allowlist is the load-bearing half: `windows` is the word every runner label and filename uses,
  it previously fell through to the linux branch, and it would have published a flawless
  `canary-windows-x64-update.json` that no client ever fetches.
- `scripts/package-windows-launched-tree.ts` reads `retainedUnpackDir` out of
  `windows-app-launch-proof.json` and zips **that** directory, after checking the launcher the
  proof named is still inside it. It structurally cannot zip a re-extraction, which is the
  property `downloadable-windows-build-is-the-launched-tree.md` exists to keep — the same rule,
  now applied to a file in the bucket instead of a CI artifact.

  **The Windows build is not byte-reproducible, which turns that rule from tidy into load-bearing.**
  Three runs built sha `068ea95df` and produced three artifacts of the same name at 130 056 815,
  130 056 817 and 130 056 830 bytes — a 15-byte spread, measured through the artifacts API filtered
  by name. So "extract the same archive again" does not even yield the same bytes as another run's
  tree, and *which* run a `.zip` came from is not recoverable from its name. Only the same run's
  retained directory qualifies, and only the run id identifies it.
- The run summary carries the unsigned-launch warning as prose next to the download link. Hiding
  it turns a SmartScreen dialog into a malware verdict.

## What the unsigned warning actually does — measured, not predicted

Artifact `windows-app-068ea95df…` from run **31781800859** (v1.44.0), downloaded in a browser onto
a real x64 Windows machine, extracted to `D:\tmp\dev-3.0-canary`, launched via `bin\launcher.exe`
(583 KB in Explorer = the 596 992 bytes the launch proof recorded for that executable):

| | Observed |
|---|---|
| First launch | a full-screen blue SmartScreen warning |
| Clicks to get past it | **two** — «Подробнее», then «Всё равно запустить» (ru-RU machine; the en-US strings are *More info* / *Run anyway*, inferred from the standard pair, not read) |
| Title / body text | **not captured.** It is localised, and the operator reported it is awkward to screenshot |
| After clicking through | the app runs. Title bar `[CANARY] dev-3.0 v1.44.0`, board renders, a task was created and a Claude Code agent ran in a Windows worktree over PowerShell |
| Browser warning while downloading | **not reported.** Unknown, not "absent" |

So the cost of shipping unsigned is two extra clicks, once per build, and a scary full-screen
dialog that a first-time user will read as a malware verdict unless something tells them otherwise.
That is why the download instructions in `package-windows-launched-tree.ts` name the click path
explicitly and say the warning means *unrecognised publisher*, not *virus found*. The title line is
deliberately not quoted there — quoting the English one on a machine that shows Russian, or the
reverse, would be worse than describing it.

## "Launched on Windows" is meaningless without naming which bytes

Because the build is not reproducible, there are three different claims here and they are easy to
collapse into one sentence that sounds stronger than any of them:

| Claim | Proven by | Names the bytes as |
|---|---|---|
| the published zip's bytes reached a window and shut down cleanly | `verify:win-app-launch` in the publishing run | that run's id |
| a build of this code runs on real hardware, and the OS warning says *X* | a human launching a CI artifact | that artifact's run id |
| **the published bytes reached a window on a human's machine** | a human launching the zip **from the bucket** | the bucket key |

Only the third is acceptance, and it cannot exist before the publish — so **it must never gate the
PR or the merge**, or the task deadlocks on a file that does not exist yet. It is a short second
pass taken immediately after the first publish.

Never write "launched on Windows" unqualified in a report. Say which byte set, named by run id or
bucket key. A green first pass followed by a failing second pass is the most valuable outcome this
sequence can produce, not an embarrassment: it would mean the publishing path corrupts something
the proof does not look at.

## Never bootstrap a platform by dispatching `canary-publish.yml` from a branch

It is the obvious move — the branch has the platform in `CANARY_PLATFORMS` and the build job,
`main` has neither, so a `--ref <branch>` dispatch looks like a way to observe the new manifest
before merging anything. It was proposed twice while this task ran. **It publishes the other four
platforms from unmerged code, and it corrupts canary ordering for them.**

`decidePlatformPublish` compares the published `sha` against `GITHUB_SHA`, which on a branch
dispatch is the branch head. Measured at the time of writing:

| | sha | buildOrder |
|---|---|---|
| published canary manifests (all four) | `7a9d230fb` | 1618 |
| `main` | `7a9d230fb` | 1618 |
| this branch | `9169b4e9d` | 1619 |

So every platform reports BUILD, and `publish: true` is a literal on this path. macOS and Linux
canary users are then offered 1619 — greater than their 1618, so they install it — from a commit
that is not on `main`. Then the squash merge of that same PR lands on `main` at **1619 as well**,
because `git rev-list --count` moves by one per squashed PR. Remote 1619 is not greater than local
1619, so those users are never offered the merged build and sit on an off-`main` bundle until an
unrelated merge reaches 1620.

The safe bootstrap is instead: **merge, then dispatch on `main` as the very next action**, read
the new manifest anonymously, and cite the 200.

Between those two moments Windows is selectable with nothing in the bucket to select — the window
`canaryPublishesFor()` necessarily creates, measured at 15–20 minutes off run 31257371545 and
**unbounded if the never-before-executed Windows build job fails on its first run**. It is
survivable for one reason, and it is not the length: **no Windows user can be running a build
from that commit at all**, because Windows has no distribution channel until this leg publishes —
which is the entire premise of this change. The only possible holders are people who pull CI
artifacts or run from source, and they are the ones equipped to read a run summary.

That safety is temporary and specific to the first Windows publish. Once Windows is distributed,
the same window would be a real 403 for real users, so a second platform must not be bootstrapped
this way without re-deriving the argument.

## Risks

- **Windows is packaged twice per canary run**: once by the `windows-proof` gate, once by this
  publisher. Measured ~3 minutes for the packaging half, so it is paid knowingly. Folding the
  upload into `windows-conpty-package.yml` would have removed it, but that workflow is also
  `release.yml`'s gate, and editing it reaches the stable release path.
- **No Windows CLI tarball.** `create-cli-tarball.sh` has no Windows branch; `dev3.exe` ships
  inside the bundle (asserted by the launch proof), so nothing is missing from the app — but a
  Windows user cannot install the CLI standalone the way a macOS or Linux user can.
- **The self-extracting installer is still unpublished and still unproven.** Anyone finding
  `dev-3.0-Setup-canary.zip` in the build output must not assume it was vetted. Closing that gap
  means growing the launch proof a second target (install, launch from there, uninstall).
- **`stable-win-x64-update.json` does not exist**, so a Windows build's update check 403s
  forever until stable also publishes Windows. Out of scope here, and named rather than left to
  be rediscovered.
- **Windows canary has no arm64 leg.** A Windows-on-ARM machine runs the x64 build under
  emulation, untested by anything.

## Alternatives considered

- **Publish the Setup installer as the first install.** It is the shape a real Windows release
  would ship, which is exactly why handing it out unproven is worse than not handing it out:
  the unvetted thing would be the one with a future. Deferred, not rejected.
- **Add the S3 upload to `windows-conpty-package.yml`** and reuse the build the proof already
  makes. Saves the duplicate packaging, but that file is `release.yml`'s gate, so it drags the
  stable path into a canary change.
- **Ship Windows in tagged stable releases at the same time.** Rejected by Arseny's own
  instruction, and correct on its own merits: the first unsigned Windows build meeting real
  users should meet the ones who opted into surprises.
- **Buy a code-signing certificate.** Ruled out by the user, and not revisited here.
