# Rename the second update channel to canary, and delete the vendor patch it depended on

## Context

The second update channel shipped as `unstable` in #1284/#1288 and **never worked once**.
`electrobun build --env=unstable` gates on a three-element allowlist (`dev`, `canary`,
`stable`) and, outside it, **silently falls back to `dev`**. We carried a one-line vendored
patch adding `"unstable"` to that list in `src/cli/index.ts`.

## Investigation

The patch never had any effect. `node_modules/electrobun/bin/electrobun.cjs` →
`ensureCliBinary()` looks for `bin/electrobun`, then `.cache/electrobun`, and otherwise
**downloads a compiled CLI** from the vendor's GitHub releases and spawns that. `src/cli/index.ts`
is never executed by a build. Locally the illusion held because a cached binary sat in
`.cache/` from May and no real `--env=unstable` build was ever run on this machine.

**Three guards asserted the patch and all three were vacuous** — declared for the pinned
version, applied to `node_modules`, only extends the list. Every one describes a source file
nobody runs. The defect was caught by the one check that asserts a **result**: the built-folder
comparison in `create-release-artifacts.sh` (`expected ./build/unstable-linux-x64 but found
./build/dev-linux-x64`), on the first scheduled run, 31251014417.

This is the same failure shape as the bootstrap bug earlier in the same stack, one level
deeper. There, a correct rule was fed by a probe that could not tell "absent" from "denied".
Here, a correct assertion names an artifact that is not the executable one. **A test that
asserts intent cannot see that the thing it names is not the thing that runs.**

Alternatives were measured before choosing (see below). The decisive fact for the rename:
`--env` affects only **naming and a label** for any non-`dev` value — `getAppFileName`,
`getDmgVolumeName`, `getPlatformPrefix`, plus `channel` written into `version.json` and
`ELECTROBUN_BUILD_ENV`. Every real behavioural branch in electrobun's build is `dev` vs
not-`dev`, never per-channel, and the app identifier comes from config, not from the
environment. So the channel is a name — and a name we do not have to fight the vendor for.

## Decision

**Rename the channel `unstable` → `canary`, which electrobun admits natively, and delete the
machinery that existed only to force the old name.** One change, no half-migration:

- `UpdateChannel = "stable" | "canary"`; `src/shared/canary-publish.ts`,
  `scripts/decide-canary-publish.ts`, `.github/workflows/canary-publish.yml` renamed with it.
- `patches/`, `patchedDependencies` in `package.json`, its `bun.lock` entry, and
  `electrobun-channel-patch.test.ts` (all three vacuous guards) **deleted**.
- The two diagnostics in `create-release-artifacts.sh` that blamed "the vendored patch stopped
  applying" now say what is actually true: the installed electrobun does not admit this
  channel, and patching its source cannot help because the CLI is a downloaded binary. A stale
  hint costs more than no hint — it sends the next reader somewhere specific and wrong.
- The hourly schedule, switched off in #1307 because every tick failed, is back on: the reason
  it was off is gone rather than waived.

**No migration, by construction.** `coerceUpdateChannel` degrades anything that is not exactly
the current channel name to `stable`, so a value written by v1.42.1 stops matching and
collapses in memory, on load. Nothing under `~/.dev3.0/` is rewritten, so an older installed
build still reads what it wrote. The rename was only free because nothing had ever been
published under `unstable-*` — all four keys answered 403. That window shuts on the first
successful publish.

**`CANARY_FEED_AVAILABLE` stays `false` for now**, so the Settings control stays disabled and a
persisted choice still collapses. Deliberately narrower than "the build works": a build path
electrobun supports natively is not the same claim as a manifest readable in the bucket, and
shipping the control on the first of those is exactly what v1.42.1 did. It is deleted — not
flipped — once a `canary-{os}-{arch}-update.json` has been observed.

## Risks

- **The name `canary` was already in use** for Windows CI artifacts (`package:win-archive`
  builds `--env=canary`), which published nothing. That is now a feature rather than a clash:
  the Windows build becomes the channel's first citizen instead of an exception, and build
  folder, bundle label, `appDataFolder` and feed key finally all say the same word.
- Anyone who selected the channel on v1.42.1 lands back on stable. Intended: they were on a
  channel that could not update, and it is silent rather than a prompt.
- The rejected-channel test now passes `unstable` as the invalid value — chosen because it is
  the exact string a caller left behind by this rename would send.

## Alternatives considered

- **Build our own CLI from the patched source into `.cache/electrobun`.** `ensureCliBinary()`
  accepts any file there, so it would work — and is disqualified: neither path carries a
  version, nothing compares one, and if the file survived an electrobun upgrade the failure
  would be **totally silent** (old CLI, new library, correctly-named artifacts, every existing
  guard green). It introduces a fresh instance of the exact class of defect this record is
  about. Whether it survives an upgrade was not established, and "we do not know" is itself
  disqualifying here.
- **Build as `canary`, publish as `unstable`.** No patch needed, but the bundle label, the
  `appDataFolder` path and the feed key would disagree, so a user on the `unstable` feed would
  find `canary` on disk. The rename removes the discrepancy instead of hiding it.
- **Re-sign after a post-build rename.** Puts Apple notarization on the hot path of an hourly
  job; the bundle is tarred and then deleted, and the self-extracting wrapper carries its own
  signed `channel`.
- **Wait for `blackboardsh/electrobun#517`** (fail loudly on an unknown `--env` instead of
  degrading). Correct upstream ask, unknown date, and the channel stays absent until then.
- **Seed the feed by hand, or do nothing.** Both fix an instance, not the class.
