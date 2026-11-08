# Electrobun's downloaded binaries are snapshotted into a machine-level cache

## Context
Electrobun downloads its CLI (`bin/electrobun`, 61 MB) and core binaries (`dist-<os>-<arch>/`, 75 MB) from GitHub releases on first use and stores them inside `node_modules/electrobun`. Anything that re-extracts the package deletes them. During a GitHub outage `bun run dev` died in every fresh worktree with `Failed to download electrobun CLI: Download failed: 504`.

## Investigation
New worktrees clone `node_modules` from the main checkout, so the binaries used to arrive for free. That stopped on 2026-10-26, when `patches/electrobun@1.18.1.patch` landed: the main checkout's copy has no bun patch tag, so `bun install` in each worktree re-extracts the package to apply the patch and wipes the cloned binaries. Of 18 live worktrees, every one created before that date carried binaries with the main checkout's mtime; every later one either re-downloaded them or had none. The custom Bun runtime (`bunVersion` in `electrobun.config.ts`) has the same shape: it lives in `node_modules/.electrobun-cache/bun-override`, survives `bun install`, but is re-downloaded from GitHub whenever the cloned copy is another version.

## Decision
`scripts/electrobun-binary-cache.ts` snapshots what electrobun itself downloaded, and `main()` in `scripts/dev.ts` calls it around the build: `restoreElectrobunBinaries` before the plan, `storeElectrobunBinaries` after it succeeds. Entries live in the OS cache directory (`binaryCacheRoot`, overridable with `DEV3_ELECTROBUN_CACHE_DIR`), keyed by the electrobun package version and host, and by the `.bun-version` stamp for the Bun override. Restore only fills gaps for the exact version the checkout asks for, so a version the cache has never seen is downloaded by electrobun exactly as before. Entries are written once through a rename, stored only after a successful build, and pruned to `KEPT_VERSIONS` least-recently-used versions. Both calls report and swallow their own errors.

## Risks
The cache trusts the first successful build of a version: if upstream ever re-publishes assets under an existing tag, restored checkouts keep the old bytes until the cache directory is deleted. A future electrobun that keeps its downloads elsewhere makes the cache a no-op, not a failure. Only `bun run dev` / `bun run start` use it; `bun run build` and release CI stay on the unmodified download path on purpose.

## Alternatives considered
- Keep the main checkout's `node_modules` patched and built so clones carry the binaries: zero code and worth doing anyway, but it silently decays at the next patch or version bump.
- Download the release tarballs ourselves with pinned hashes, as `scripts/fetch-bifrost.ts` does: duplicates electrobun's URL and layout logic, which is exactly what breaks on a new version.
- Patch `bin/electrobun.cjs` through `patchedDependencies`: the patch is pinned to one version, and the core download lives in the compiled CLI, which a source patch cannot reach.
- Try the network first and fall back to the cache: needs the same downloader, and re-downloads 136 MB per worktree for bytes already on disk.
