# 212 — Stable and unstable update channels

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

**In-place switching is macOS-only, and says so.** `Updater.appDataFolder()` is
`{appData}/{identifier}/{channel}`. On macOS that folder is only download scratch and the swap
targets `process.execPath`, so retargeting the cached `localInfo` is coherent. On Linux and
Windows the running app **is** `{appDataFolder}/app`, so a retargeted channel would install into a
directory the launcher does not run from: the user restarts, sees no change, and nothing reports a
failure. Those platforms therefore **refuse with a named message** and keep the saved setting — a
silent no-op is worse than a refusal.

## 3a. WINDOWS_SCOPE_PATHS is a union of two invariants, not one

Establishing this was forced by the extract that PR1 performs. `WINDOWS_SCOPE_PATHS`
(`src/shared/windows-ci-scope.ts`) looks like one list with one meaning, and it is not:

1. **ships into, or is exercised by, the packaged Windows proof** — `windows-conpty-package.yml`,
   the host-image scripts, the native terminal registry;
2. **carries the Bun pin every workflow must hold in lockstep** — drift there means the repo's
   pins no longer agree, so the packaged proof stops being evidence about the runtime anyone
   actually ships. This is why `electrobun.config.ts` and `package.json` are on the list even
   though neither builds Windows.

The extracted reusable build workflow is **IN under (2) and OUT under (1)**: `release.yml` builds
no Windows at all — it *calls* `windows-conpty-package.yml` as a proof job — so the extracted file
carries macOS and Linux only, while still installing the Bun that builds and ships the app.
`unstable-publish.yml` is in under both.

That is two reasons feeding one list, not a contradiction. Each entry therefore states **which
criterion earned it**, and an entry may only be deleted by defeating that specific reason. The
comment that previously justified the workflow entries by the packaged-runtime reason alone was
stale after the extract and now names both.

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
  (`decisions/211-windows-proof-post-merge-not-pull-request.md`) is **not** redundant — it keeps
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
