# The canary version suffix reaches the feed, and stripping it is load-bearing

## 1. Context

`decisions/2026/08/06/stable-unstable-update-channels.md` decided the canary display version:
`1.42.3+canary.<short-sha>`, blessed by Arseny as build metadata appended to *his* version
rather than an invented number, and it stated the suffix "lives only in the published
manifest". `canaryDisplayVersion()` was written, unit tested, and **never called by anything
that runs**. `git grep` found it in `src/bun/__tests__/update-channel.test.ts` and nowhere
else.

So the feed published a bare version. Measured in the live bucket on 2026-08-09: stable
`1.42.3` hash `lratln5c8lan` and canary `1.42.3` hash `ohtm1drf1drc`, same commit `a0981f557`,
same `buildOrder` 1622. Arseny switched to canary, was correctly offered the canary artifact
(the hash differs, so the channel-crossing path worked), and the popover told him
**"v1.42.3 ready to install"** with **"WHAT'S NEW IN V1.42.3"** — a stable release's name on a
build off main.

This is the third instance of one shape in this stack: the vendored electrobun patch that
edited a file the build never executes, the anonymous feed probe that could not tell absent
from denied, and now a helper with a green test and no caller. **A test that asserts intent
cannot see that the thing it names is not the thing that runs.**

## 2. Investigation

The obvious fix — wire the helper in — is not sufficient on its own, and that only shows up
when you run it.

`isNewerVersion` (`src/shared/version.ts`) splits on `.` and `Number()`s the parts. On
`1.42.3+canary.a0981f55` the third part is `"3+canary"` → `NaN` → `|| 0` → **0**. The prior
record described this as the suffix being "swallowed", and the existing test used `1.42.0`,
where zeroing the patch is invisible. It is not swallowed: **the patch is destroyed**, so the
string parses as `1.42.0`, strictly LOWER than the release it was cut from.

`decideUpdate`'s channel-crossing branch computes `installsOlderBuild` with that comparator,
and its comment claimed it "compares the CORE versions". Measured before changing anything:

```
decideUpdate({version:"1.42.3",channel:"stable"}, "canary", {version:"1.42.3+canary.a0981f55"})
  → { kind:"switch", to:"canary", installsOlderBuild: true }
```

So publishing the suffix alone would have made the most ordinary crossing there is — a stable
user moving to the canary build of the same release — warn about a downgrade, and that
warning is not decorative: it is what tells the user an older build is about to read state a
newer one wrote.

Separately, the popover's what's-new payload is the changelog window **after the previous
release tag** (`scripts/build-update-changelog.ts` → `selectReleaseWindowFromGit`). On a
tagged stable release those entries are the release. On canary they are precisely the changes
that release does NOT contain, so "What's new in v1.42.3" states the opposite of the truth.

## 3. Decision

**One producer, one consumer, both in `src/shared/update-channel.ts`.**

- `scripts/create-release-artifacts.sh` gains `publish_version()`, which calls the existing
  `canaryDisplayVersion()` through `bun -e` for `CHANNEL=canary` and echoes the bundle version
  untouched otherwise. It feeds both `update.json` writes (the electrobun-succeeded path and
  the crash-recovery path). The bundle's `version.json` is not touched and cannot be — it is
  already sealed inside the tarball — which keeps `dev3 doctor`'s string-equality check honest.
- `parseDisplayVersion()` is the inverse, and it is what the UI reads. **The suffix is the only
  thing that describes the build being OFFERED**: during a crossing the local channel is the
  one being left, so it answers the wrong question. A manifest with no suffix yields no
  channel and every surface degrades to exactly its previous rendering.
- `decideUpdate` runs both sides of the `installsOlderBuild` comparison through `coreVersion()`.
  **`isNewerVersion` itself is untouched** — teaching it build metadata would re-enable the
  dead ordering path the prior record pins deliberately. Two canary builds still compare equal,
  canary still orders by `buildOrder`, and a real downgrade (canary cut from 1.42.3 offered to
  a running 1.43.0) still reports `true`; both are pinned.
- UI: a neutral `CanaryBadge` (`bg-raised`, no accent — accent belongs to the Restart button)
  next to the version in the update popover, the update toast, and About. About reads the
  channel baked into the running bundle, carried on the `showAbout` push payload, with the sha
  from `BUILD_COMMIT`. **No header chip** — the header's ambient-readout budget is 1 and memory
  headroom owns it; that placement was already rejected in the prior record and stays rejected.
- The popover's heading becomes "What's new **since** v1.42.3" on canary only.

**Acceptance is a manifest key in the bucket, not a green test** — the helper already had one
of those. The proof is `create-release-artifacts.test.ts` running the real script over a real
git repo and reading the file it wrote, plus a control run on `stable` in the same test, and
the assertion was mutation-proved by forcing `publish_version()` to always echo its argument.

## 4. Risks

- `bun -e` inside the release script adds a bun invocation on the publish path. It resolves the
  module by an absolute path derived from the script's own location, so it works from the repo
  root (CI) and from a temp dir (tests); a failure is loud, since `set -euo pipefail` is on.
- `isUpdateAlreadyReady()` compares the remembered ready version with the offered one through
  `isNewerVersion`, so two different canary builds still read as "already ready". Unchanged by
  this work — both were bare `1.42.3` before — but the suffix makes it look like it should have
  been fixed here. It is a separate defect on the download-dedup path, not the ordering path.
- The badge is keyed on `channel === "canary"` rather than "not stable", so a future third
  channel renders no badge until it is added.

## 5. Alternatives considered

- **Pass the channel to the popover as a prop.** More plumbing, and wrong during a crossing:
  the local channel names the build being left, not the one on offer.
- **Teach `isNewerVersion` about build metadata.** Rejected by the prior record and still
  rejected: the sha is not monotonic, so "same core, different metadata means newer" is a lie
  that only holds while the feed happens to move forward.
- **Put the raw `1.42.3+canary.a0981f55` in the popover sentence.** Reads as a typo, and the
  sha is then buried in a heading nobody parses.
- **A permanent channel readout in the global header.** Rejected in the prior record's UX pass;
  re-confirmed here.
