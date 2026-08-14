# The Windows zip is attached to every tagged release, unsigned, and the release notes carry the warning

## Context

`windows-ships-through-canary-first.md` decided Windows would publish to the canary channel and
**only** canary — "`release.yml` gets no Windows caller — an unsigned build does not belong in the
feed ordinary users poll". That leg landed (PR #1350, #1351). The release page did not move: as of
2026-08-14, v1.44.0's assets are two macOS DMGs and four CLI tarballs, and a human who wants dev3
on Windows has nowhere to click. The only Windows bytes reachable at all were a CI-run artifact
named by commit sha, on a run page, behind a GitHub login, expiring in 30 days.

Asked where a Windows build has to appear to count as shipped, Arseny answered **"1+2"** — the
release page **and** the canary channel, both. On the shape: *"мне нужно, чтобы windows.exe в
артефактах появился, даже если он не очень-то стабильный"*. On signing, unchanged from the earlier
record: *"сертификата у меня нет и я покупать не хочу"*.

So the canary-only half of that decision is superseded, and its reasoning ("unsigned does not
belong where ordinary users are") is answered rather than refuted: the users are told, in the
release notes, next to the download.

## Investigation

The gap was distribution, and almost nothing needed building. `release-build-windows.yml` already
packages, launch-proves, zips the launched tree and syncs to S3 for canary;
`create-release-artifacts.sh` already has a `win` branch and an OS allowlist;
`getPlatformPrefix()` already returns `win-x64`. What was missing was a second caller and two
lines of plumbing in the release job.

The asset shape was the one real choice:

| Shape | Openable on a stock box | Ever launched | Cost |
|---|---|---|---|
| the launched tree, zipped | yes | **yes**, by `verify:win-app-launch` in the same run | none — already built |
| `dev-3.0-Setup-*.exe` installer | yes | **no job, test or proof has ever run it** | a second launch-proof target |
| `*-win-x64-*.tar.zst` | **no** — Windows `tar.exe` has no zstd | yes | none, and unusable |

The zip wins on both of Arseny's constraints at once: it is the fastest path to a runnable
download, and it is the only candidate that is both openable and proven.

## Decision

**`release.yml` gains a `build-win-x64` caller, and the Windows zip is attached to the release.**

- New job `build-win-x64` in `release.yml`, `channel: stable`, `needs: [prepare, windows-proof]`
  like every other publisher, and added to the `release` job's `needs:` so the release body is not
  cut before the zip exists.
- **`bestEffort: true`, and a mandatory warning when the zip is then absent.**
  **SUPERSEDED the same day by `windows-failure-fails-the-release.md`:** Arseny made Windows
  first-class, the input and the warning step are both gone, and a failed Windows build now stops
  the entire release. The rest of this bullet is the reasoning that held until then.
  The first draft made
  the Windows leg fatal, reasoning that `windows-proof` already fails the release on a broken
  Windows build. Raised as a risk before the PR and ruled on: a Windows packaging failure must not
  block the macOS and Linux release, because by then both have already run their own
  `aws s3 sync` — including the sync to the bucket root the updater polls — so failing here
  abandons a shipped update halfway and produces no GitHub Release at all. `release-build-windows.yml`
  therefore takes the same `bestEffort` input as `release-build-linux.yml` (`continue-on-error` at
  job level, because a caller reads the called job's result), `release.yml` passes `true`,
  `canary-publish.yml` passes `false` — the value that reproduces today's behaviour, since `false`
  is GitHub's default for `continue-on-error`; nothing else at that call site changed. The
  mechanism was chosen on precedent: the pattern already exists here and is already exercised,
  where an `if: always() && …` on the `release` job would be hand-rolled boolean logic in the one
  place this repo has provably been burned by string truthiness, and a follow-up workflow
  attaching the zip after publication would leave the release page briefly telling Windows users
  they are unsupported.
  **The warning is half the mechanism, not a nicety:** `continue-on-error` alone turns a broken
  Windows publish into a release that is quietly Windows-less and indistinguishable from success.
  The `Warn when the Windows build is missing` step names the platform, the tag and the run URL,
  in the log and in the run summary, and deliberately does not fail — failing would recreate the
  hostage situation one step later.
- The `release` job uploads `all-artifacts/*win-x64*.zip` with `gh release upload`, skipping
  `*Setup*`: the self-extracting installer is still unproven, and
  `downloadable-windows-build-is-the-launched-tree.md` governs.
- **The Windows section of the release body is rendered by the Windows job, not written in
  `release.yml`.** `package-windows-launched-tree.ts` already reads `bundleRoot` and
  `desktopExecutableRelativePath` out of `windows-app-launch-proof.json`; it now also writes
  `windows-release-notes.md` (outside `artifacts-win-x64/`, so it is not published as a bucket
  file), uploaded as its own CI artifact and appended verbatim. The release workflow runs on
  ubuntu and cannot know which executable the proof spawned — anything it spelled out itself
  would be a guess, and `workflow-windows-release-asset.test.ts` fails if `launcher.exe` appears
  in that file.
- The unsigned-launch warning moved into `scripts/windows-release-notes.ts` as one string with two
  renderers (release body, CI run summary), so the two destinations cannot drift. It names the
  measured click path — **More info** → **Run anyway** — and says the dialog means *unrecognised
  publisher*, not *virus*. It deliberately does not quote the dialog title: the only observation
  is from a ru-RU machine («Подробнее», «Всё равно запустить»), and the en-US title is recorded as
  unknown, not absent.
- `docs/install.md` gains a Windows section with the same click path, and says plainly that the
  link 404s on releases predating this change.

Publishing `stable-win-x64-update.json` follows from reusing the leg unchanged, and it closes a
hole the earlier record named: a Windows build's update check used to 403 forever. The canary half
went live while this was being written — `canary-win-x64-update.json` now answers 200 with
`1.44.0+canary.b2d848d7`, buildOrder 1655, published by run 31793304656 alongside a
126 850 884-byte `canary-win-x64-dev-3.0-canary.zip` — so the two channels differ only in which
users they reach.

## Risks

- **The release now waits on a ~25-35 minute Windows job.** It becomes the critical path to the
  GitHub Release even when it succeeds. Not mitigated — the alternative is publishing the release
  before its Windows asset exists.
- **`bestEffort: true` swallows a failed Windows S3 sync as well as a failed build.** The absence
  is loud (warning + run summary), the *cause* is one job page away. Tightening it would mean
  distinguishing "did not build" from "built and failed to upload", which is more machinery than
  the difference buys today.
- **The zip is 121.0 MB** as a release asset, per release, forever — measured on windows-latest in
  the first stable-channel build (run 31799430704), not the ~400 MB every older comment quoted;
  that figure is the extracted tree, and it had been repeated for the download for months. GitHub's
  per-asset limit is 2 GB and storage on a public repo is free, so this is a listing-clutter cost,
  not a bill.
- **Unsigned means SmartScreen every time.** Two clicks, measured once on one machine, in one
  locale. A browser-side download warning was never reported — unknown, not absent.
- **"Launched on Windows" is not a property of a commit.** Windows trees are not byte-reproducible:
  one sha, three runs, 130 056 815 / 130 056 817 / 130 056 830 bytes. Only a run id or a bucket key
  identifies the bytes anybody ran, so acceptance is downloading the release asset itself.
- **No Windows CLI tarball, no installer, no arm64 leg**, all unchanged from the canary record.
- **`docs/index.html` still says "Windows coming soon"** and is deliberately untouched: Pages
  deploys on merge, but the asset only exists after the next tag. It becomes false-in-the-other-
  direction the moment a release carries the zip, which is a one-line follow-up for the landing
  page, not something to ship early.

## Alternatives considered

- **Copy the canary zip into the release assets.** Cheapest in CI minutes, and wrong: the bytes
  would come from a different commit than the tag, wear canary names, and chain the stable release
  to the canary channel.
- **Build and ship the self-extracting installer instead.** The shape a real Windows release will
  eventually take, which is exactly why handing it out unproven is worse than not handing it out.
  Deferred, not rejected.
- **Link the canary bucket from the release notes and attach nothing.** Fails the ask: the release
  page still carries no Windows file, and a canary link rots on the next canary build.
- **Wait for a code-signing certificate.** Ruled out by the user, twice.
