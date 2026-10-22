# Strip electrobun's 3D engines from the main bundle and the CLI

## Context

`electrobun/bun` (1.18.1, `dist/api/bun/index.ts`) does `import * as three from "three"` and `import * as babylon from "@babylonjs/core"`, then re-exports both as named exports and as fields of the default `Electrobun` object. A namespace stored in an exported object cannot be tree-shaken, so every bundle that imports `electrobun/bun` carried both engines. dev3 uses neither: it has no GPU window, WGPU view or 3D code.

## Investigation

The shipped v1.60.0 main bundle (`Resources/app/bun/index.js`, unminified, with Bun's `// node_modules/...` section markers) was 16.76 MB, and 10.12 MB of that was `@babylonjs/core` and 1.23 MB was `three`. The compiled `dev3` CLI embedded the same modules, because `src/cli/commands/update.ts` reaches the Electrobun platform shim, which can `import("electrobun/bun")`. Local builds on Bun 1.3.14, before → after: main bundle 16.78 → 5.40 MB (zstd-19: 2.47 → 1.09 MB), CLI binary 80.77 → 69.27 MB. As a proxy, evaluating the 3D-only bundle cost about 110 ms and +80 MB RSS. Full audit: Seq 2211.

## Decision

A `bun patch` of electrobun (`patches/electrobun@1.18.1.patch`, registered in `patchedDependencies` next to the ghostty-web patch) deletes the two imports and their four export sites. One patch covers every bundle, the main process and the CLI alike, without touching either build pipeline. `src/bun/__tests__/electrobun-config.test.ts` fails when the installed `electrobun/bun` imports either engine again, for example after a version bump that drops the patch. `bun install` already fails loudly when the patch no longer applies.

## Risks

- An electrobun bump needs the patch regenerated, or deleted if upstream fixes the barrel.
- If electrobun ever starts using `three`/`babylon` internally, the patch removes something it needs. In 1.18.1 the only references are the re-exports.
- Both packages are still declared by electrobun, so they remain in `bun.lock` and `node_modules`. Only the shipped bundles shrink.

## Alternatives considered

- **A Bun `onResolve` stub plugin.** `electrobun.config.ts → build.bun` spreads into `Bun.build`, so plugins work for the main bundle. The CLI, however, builds with `bun build --compile` on the command line, which takes no plugins, so it would have to move to the `Bun.build({ compile })` API. That changes release-critical defaults (production mode, Windows `.exe` and signing) to fix something a five-line patch already fixes.
- **Marking the modules `external`.** Rejected: packaged apps ship no `node_modules`, so any import of them would throw at runtime.
- **An upstream electrobun issue/PR** moving 3D behind a subpath export. Still worth doing, and once it lands this patch can go. Not filed: that is a public action the maintainer has to approve.
