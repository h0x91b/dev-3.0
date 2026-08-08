# Stable and unstable update channels

Companion record: `decisions/2026/08/06/extract-reusable-release-build-workflows.md`. It owns the
release-pipeline refactor the channel work needed, and everything that refactor taught: the
publish-guard finding, the equivalence-anchor rule, the dead recovery branches, the coverage caps.
This record owns only what a channel *is*. The two are independent; either can merge first.

Written as `218-…` while records were still numbered, and moved when the dated layout landed. Every
citation of both records is by **slug**, so the move touched no reference.

## 1. Context

Betas shipped constantly and every user ate them: there was one feed, so any build published
to the bucket root reached everyone. Arseny wanted the firehose opt-in — one installation, a
switch in Settings, stable by default, unstable fed from `main` without a tag (versioning stays
his).

Most of the mechanism already existed and had never been finished. `GlobalSettings.updateChannel`
(`"stable" | "canary"`), a Settings `<select>` with i18n in three locales, and a fully
channel-parameterised updater were all in the code — but every release job ran
`electrobun build --env=stable`, so `canary-*-update.json` was a 403 and
`src/bun/updater.ts` literally logged *"Cross-channel download not yet fully implemented"*.
The control carried a hardcoded `disabled`, so it was a **latent** trap rather than a live bug:
nobody could reach it, and it would have gone live the moment someone removed that attribute
without shipping the feed. Ordering rule for this work therefore: ship the feed before enabling
the control.

## 2. Investigation

Established against `vendor-docs/electrobun/` and the real electrobun 1.18.1 source, not memory:

- The channel is **baked into the bundle at build time** (`Resources/version.json`:
  `{version, hash, channel, baseUrl, name, identifier}`). The CLI flag is
  `--env=dev|canary|stable`; an unrecognised value silently falls back to `dev`. (`build:prod`
  in `package.json` passes `--channel prod`, which electrobun does not parse — so it produces a
  dev build. Flagged, not fixed here.)
- The feed is flat, one set per channel+platform: `{baseUrl}/{channel}-{os}-{arch}-update.json`,
  `-{AppName}.app.tar.zst`, `-{hash}.patch` (`api/shared/naming.ts`). Non-stable channels also
  suffix the app file name, and `version.json.name` carries the suffix.
- Electrobun's updater decides by **hash inequality** — it will install an older build. dev3's
  wrapper decided by **semver** — it will not. That asymmetry was the downgrade lockout.
- Electrobun has **no runtime channel switch** (a literal `// todo: allow switching channels`).
- `dev3 doctor` (`src/cli/commands/doctor.ts:158`) compares the bundle version to the CLI
  version by **string equality**. This constrains *where the unstable version suffix may live*.

## 3. Decision

**How a channel is represented on disk.** One field, `updateChannel: "stable" | "unstable"`, in
`~/.dev3.0/settings.json`. `coerceUpdateChannel()` (`src/shared/update-channel.ts`) is the single
reader: anything not exactly `"unstable"` becomes `"stable"`. That fallback is load-bearing, not
tidiness — the settings file is shared by every installed version on the machine, so an N-2 build
can read a channel name it has never heard of, and degrading to stable is what makes that safe.
It is also what let `"canary"` be deleted outright with no compatibility alias. Pinned by
`src/bun/__tests__/update-channel.test.ts`.

**How a channel is represented in the feed.** Only as a filename prefix, in the same bucket and
the same prefix as before (`s3://h0x91b-releases/dev-3.0/`). `create-release-artifacts.sh` takes
the channel as a **required** third argument — deliberately not defaulted, because it prefixes
every artifact name and a default would let a future caller publish one channel's build into the
other channel's feed with every test green. It remains the **single writer** of the published
`update.json`, and now adds two fields:

| Field | Question it answers | Read by |
|---|---|---|
| `sha` | WHICH COMMIT this build came from | the hourly workflow's skip check |
| `buildOrder` | WHICH OF TWO BUILDS IS NEWER | unstable clients' ordering |

Neither is derivable from the other. A re-run on the same commit reproduces both, so it neither
reinstalls for clients nor rebuilds for CI — that is what makes the manual dispatch safe to press
twice. `buildOrder` is `git rev-list --count HEAD`, **monotonic because `main` is squash-merged**:
its history is linear, so the count rises by exactly one per merge. That is a property of how this
repo lands PRs, not of git. Allow merge commits onto `main` and this ordering has to change with it.

**The unstable version carries no ordering.** Display version is `1.42.0+unstable.<short-sha>`,
blessed by Arseny as build metadata appended to *his* version rather than an invented number. Two
unstable builds cannot be compared by their strings, because the sha is not monotonic — anything
wanting "newer" must use `buildOrder`. This is a property of the format, not a caveat.
`isNewerVersion` does not reject the suffix, it **swallows it**: `"0+unstable"` → `Number()` →
`NaN` → `|| 0` → `0`, so the string parses as a plain `1.42.0` with no throw and no warning, and
two consecutive unstable builds compare EQUAL. Routing unstable through semver would therefore
mean *install once, never update again until the next stable minor bump*. That broken behaviour is
pinned by a test so nobody "fixes" the comparator and silently re-enables the dead path.
**The suffix lives only in the published manifest and must never enter the bundle's
`version.json`**, or `doctor`'s string equality reports a spurious CLI/app mismatch.

**Three ordering rules, kept separate** (`decideUpdate()`): crossing channels compares **hash**;
staying on stable compares **semver**; staying on unstable compares **buildOrder**. The hash
comparison is confined to the crossing case on purpose — leaking it into the routine check would
turn every republish of the same commit into a pointless download and restart. An unstable
manifest with no `buildOrder` is an **error**, never a fallback comparison.

**What happens on a downgrade.** Switching back to stable while stable is behind **installs the
older stable build**. The alternative — waiting for stable to catch up — strands the user on the
build they just rejected; that is a lockout, not a policy. The offer is worded as a direction,
`Switch to stable (1.42.0)`, never "Update available", in both directions.
**The riskiest consequence of this whole feature:** that older build then reads `tasks.json`,
`settings.json` and `data/<slug>/` that a NEWER build already wrote. A channel switch is now the
most likely way a user runs an older build than the one that last wrote their state, so the N-2
readability rule in `AGENTS.md` is no longer theoretical — any schema change from here goes behind
a parallel path, never an in-place rewrite. The confirmation dialog says this out loud rather than
leaving it to be discovered.

**What a brew user's in-app switch means.** The cask installs `/Applications/dev-3.0.app` and
already sets `auto_updates true`, so bulk `brew upgrade` skips dev3. macOS `applyUpdate()` moves
the new bundle onto the **currently running** path, so a channel crossing never renames the bundle
to `dev-3.0-unstable.app` and brew's install path survives. The Caskroom keeps recording the last
stable version — expected, and `doctor` already says so. An explicit
`brew upgrade --cask dev3` pulls an unstable user back to stable; that is acceptable because it is
explicit, and the in-app setting still says unstable, so the next check offers the switch again.

**How the bundle learns it is unstable: a one-line vendored patch, not a fork.** electrobun's CLI
gates `--env` on `["dev","canary","stable"].includes(envArg) ? envArg : "dev"` (`src/cli/index.ts`)
— so the obvious `--env=unstable` does not fail, it **silently produces a dev build**. That
mechanism is the useful part: a future agent will otherwise try the obvious flag and ship a dev
bundle wearing an unstable name.

Everything below that check is already channel-generic — `getAppFileName`, `getPlatformPrefix`, the
DMG volume name, the patch naming — and electrobun's own type is
`BuildEnvironment = "stable" | "canary" | "dev" | (string & {})`, which **explicitly admits arbitrary
strings**. So `patches/electrobun@1.18.1.patch` does not extend electrobun; it removes a check that
contradicts electrobun's own type. This is the repo's first patched dependency.

*Why not patch `version.json` after the build instead?* Because there is nothing left to patch:
electrobun computes the bundle hash, writes `version.json`, tars the bundle, and then **deletes the
bundle folder** on every non-dev build. The outer self-extracting wrapper carries its own
`metadata.json` with a `channel` field and is code-signed and notarized. So "just patch the file"
means untar, patch, re-tar, re-compress, patch the wrapper, re-sign and **re-notarize** — putting
Apple's notary service on the hot path of an hourly job. Worth recording separately, because it took
reading to establish: **the hash is computed BEFORE `version.json` is written, so `version.json` is
not part of the hash** and editing it can never invalidate a bundle.

*Why not publish unstable under the existing `canary` prefix?* It would need no patch at all, and it
was rejected: it resurrects the name this change deletes, in the bucket **and** inside the bundle,
and every future reader has to learn that canary means unstable. A stored lie costs more than a
maintained patch — the patch is visible in `package.json`, the lie is visible only to whoever
already knows it.

**A lapsed patch must be RED, not silent**, because the failure mode is a dev build published under
an unstable name: it polls the wrong feed and never updates, and nothing logs it. Three guards:

| Guard | Catches |
|---|---|
| `electrobun-channel-patch.test.ts` reads the INSTALLED dependency | patch not declared for the pinned version · declared but not applied · list replaced rather than extended |
| `create-release-artifacts.sh` compares `version.json`'s channel with its channel argument | a build that succeeded on the wrong channel |
| the same script's early check for `./build/dev-*` next to a missing `./build/<channel>-*` | names the degradation instead of surfacing later as "build failed before tarring" |

**EXPIRY: this patch dies when electrobun accepts arbitrary channel strings in the CLI**, matching
its own `BuildEnvironment` type. It touches exactly one place — the `--env` allowlist in
`src/cli/index.ts` — so that is where an upgrade should look.

**Reported upstream: blackboardsh/electrobun#517.** Searched first — the closest existing issues are
#261 (reading env inside `electrobun.config.ts`) and #432 (detecting dev vs packaged at runtime), and
neither covers the `--env` allowlist. The report carries the four facts above plus the ask that
matters more than accepting custom channels: **fail loudly on an unknown `--env` instead of degrading
to `dev`.** If either lands, this patch deletes itself.

**The publisher: hourly if `main` moved, decided PER PLATFORM.** `unstable-publish.yml` probes the
already-published `unstable-{os}-{arch}-update.json` and compares its `sha` with `main`. Per platform
on purpose: a run that publishes three of four self-heals on the next tick, where one shared decision
would skip the fourth forever because `main` had not moved. `tag` is the **short sha** — there is no
tag on this path, and a constant would overwrite one archive prefix forever; the versioned prefix
therefore grows per commit with **no retention policy today**, stated rather than implied.

**ABSENT means build, UNDECIDABLE means fail** — and the probe, not the decision, is what has to
tell them apart. Mapping an unproven absence to "absent" turns one bucket-policy change into a full
sign-and-notarize cycle every hour, forever; mapping it to "present" stops publishing forever. Both
are silent, so the decision refuses and quotes what the probe actually saw.

**The first version of that probe could never bootstrap, and the live bucket is what proved it.**
The probe was an anonymous GET, on the belief that a missing key answers 404. It does not here.
`h0x91b-releases` grants no anonymous `s3:ListBucket`, so a missing key answers **403 AccessDenied**
— measured, with a deliberately invented key as the control, while `stable-macos-arm64-update.json`
answered 200 from the same caller. The consequence is a closed loop, not a risk: 403 → refuse to
build → no manifest is ever written → 403 again, every hour, forever, red every time. It would have
merged green: the unit tests all passed, because they tested the *rule* and the rule was right.

The fix is to probe **with the publishing credentials** (`aws s3 cp` through the CLI), where a
missing key answers a clean 404 and `absent` is a fact rather than a guess. That fixes the class
rather than the instance — a one-off seeding, by hand or by a `force` flag, would have left "no key"
and "no access" looking identical forever, and the next new platform would hit the same wall without
this conversation in anyone's memory. `FeedProbe` is therefore a union (`absent` / `present` /
`undecidable`) rather than an HTTP status: the type no longer lets a caller pass a status it cannot
interpret.

A `force` input on `workflow_dispatch` survives as the escape hatch — the only way out if the probe
itself cannot run — and a forced run emits `::warning::FORCED` naming that nothing was compared, so
it cannot be mistaken in the log for a normal publish. Four assertions pin all of this: the probe is
authenticated, no `fetch(` returns to it, the credentials reach the step, and the escape exists and
is wired. All four were mutation-proved.

**AN INVARIANT OVER A DIRECTORY COVERS CODE NOBODY HAS WRITTEN YET.** This publisher is the
proof rather than the theory: the assertion that every feed publisher is gated by the packaged
Windows proof is enumerated across the whole workflow directory, so it applied to
`unstable-publish.yml` the moment the file existed — and it was verified by mutation, removing
`windows-proof` from one caller's `needs`, which turned it red naming the job. A single-file
assertion would have been **silent** here, because this file did not exist when the assertion was
written. That is what buys the small noise a directory-scoped check adds to every unrelated
workflow edit.

**Cost accepted, but only on hours that publish.** The packaged Windows proof gates this publisher
too, as it gates every job that syncs the feed. So an hour in which `main` moved pays for the proof
as well as four builds — the guardrail working as designed, and not free.

It first shipped **unconditional**, on the reasoning that unlike the post-merge proof there is no
pushed range to scope against. True, and beside the point: the thing to scope against is not a
changed-path set but *whether anything publishes at all*. `main` is quiet most hours, and on a quiet
hour every platform skips, so the proof gated nothing and still packaged Windows — roughly 24 runs a
day, all of them gating an empty set. It now carries `if:` over the four `decide` outputs.

The failure mode of that condition is silent in both directions, so it is pinned by two assertions
in `unstable-publish.test.ts`: one that the `if:` exists at all, and one that derives the platform
list from `UNSTABLE_PLATFORMS` rather than re-typing it. A fifth platform added to `decide` but not
to the condition would leave the proof skipped on its hour — and GitHub skips a job whose `needs`
was skipped, so that platform's build would skip too and it would stop publishing entirely, with
nothing red anywhere. Both mutations were run and both fail naming the platform.

**In-place switching is macOS-only, and says so.** `Updater.appDataFolder()` is
`{appData}/{identifier}/{channel}`. On macOS that folder is only download scratch and the swap
targets `process.execPath`, so retargeting the cached `localInfo` is coherent. On Linux and
Windows the running app **is** `{appDataFolder}/app`, so a retargeted channel would install into a
directory the launcher does not run from: the user restarts, sees no change, and nothing reports a
failure. Those platforms therefore **refuse with a named message** and keep the saved setting — a
silent no-op is worse than a refusal.


## 4. Risks

- `buildOrder` depends on `main` staying squash-merged. Nothing enforces that mechanically.
- The `localInfo` retarget mutates a cached object inside electrobun. An upstream change to how
  `getLocalInfo()` caches would break the switch — it fails loudly (wrong URL → 403) rather than
  installing the wrong thing.
- Scheduled GitHub workflows are **best-effort and can fire late**, sometimes by many minutes. The
  interval is not exact. A late or missed tick is harmless: the next one still sees the sha
  mismatch and builds, so no artifact is ever lost permanently.
- Attribution changes shape: an hourly build covers a **range** of commits, so a broken unstable
  build tells you the range and not the culprit. That is accepted here, and it is exactly why the
  dedicated post-merge Windows proof
  (`decisions/2026/08/06/windows-proof-post-merge-not-pull-request.md`) is **not** redundant — it keeps
  the per-commit attribution this path does not provide.

## 5. Alternatives considered

- **Two Homebrew casks / two apps** — rejected by Arseny up front: one installation, a switch in
  Settings.
- **Every push to `main` publishes unstable** — accepted, then overridden by Arseny. He merges in
  **batches of 4–5 PRs** back to back, so per-push meant four wasted sign-and-notarize cycles for
  one meaningful artifact. Hourly-if-`main`-moved instead; that also removed the need for
  `cancel-in-progress`, since a cron checking a sha has no burst to collapse. The manifest-last
  upload ordering stays regardless — it protects a run that dies mid-sync, which is a different
  hazard.
- **A separate `Unstable` badge, leaving the version untouched**, and **a real pre-release semver
  like `1.43.0-unstable.N`** — both put to Arseny alongside the build-metadata suffix; he picked
  the suffix.
- **Hash-based routine check on unstable** — rejected: a workflow re-run or a manual dispatch on an
  unchanged `main` produces a new hash, so every one would become a pointless reinstall.
- **Teaching the semver comparator about build metadata** — rejected: the sha is not monotonic, so
  "same core, different metadata means newer" is a lie that only works while the feed happens to
  move forward, and it contradicts the no-ordering property above.
- **A permanent channel readout in the global header** — rejected in the UX pass: the header's
  ambient-readout budget is 1 and memory headroom owns it, and a chip reading "Stable" to
  ~everyone forever is the "wall of near-zero gauges" the UX bible bans. The conditional window /
  tab title prefix (`[UNSTABLE]`) reuses the pattern already trusted for `[DEV from src]`, costs no
  chrome, and survives browser remote mode.
