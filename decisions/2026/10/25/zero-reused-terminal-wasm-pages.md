# Zero reused terminal WASM pages

## Context

Right-docked artifact geometry changes resize the adjacent terminal; display return can also trigger refit or PTY redraw. October WebContent samples show sustained computation under WebSocket dispatch, but do not identify the function or prove those incidents share this defect. The pinned ghostty-web 0.4.0 core assumes page allocations are zeroed, although Zig's WASM allocator reuses dirty freed blocks.

## Investigation

Rebuilding Ghostty `5714ed07` with the wrapper's API patch and Zig 0.15.2 reproduces the shipped WASM byte for byte. Bounded V8/JavaScriptCore fixtures expose grapheme traps, stale rows and a style-heavy resize hang; zeroing at both `PageList.initPages`/`createPageExt` allocation sites clears them, whereas row clearing alone leaves the reflow failures. An independent agent confirmed this matrix; upstream [Ghostty #11955](https://github.com/ghostty-org/ghostty/pull/11955) repairs the same two allocation assumptions for freestanding WASM.

## Decision

Apply only `patches/ghostty-web/page-zeroing.patch`, preserving the original core/API and ReleaseSmall target. `scripts/ghostty-core/build.ts` verifies pinned inputs and output hashes; the package tooling preserves pristine npm files plus the existing ESM disposal patch and replaces all four WASM copies, including the ESM payload used by `init()`. Install the reproducible local archive through `package.json`/`bun.lock`, and run actual default-loader regressions in kill-bounded child processes.

## Risks

Zeroing adds memory-bandwidth work; finite workload measurements cannot bound every terminal history or prove the field freeze solved. The repair leaves unrelated upstream defects and the existing exact-right-margin combining-mark behavior unchanged. Rebuilds were verified on macOS arm64; other build hosts fail closed on differing hashes, and the committed WASM package is shared across runtime platforms.

## Alternatives considered

Per-terminal WASM instances avoid cross-terminal reuse but still fail first-terminal reflow; additional row clearing gave no extra coverage in the matrix. Ghostty #10337 is a broad later PageList rewrite and is unnecessary for these cases; a full upgrade would enlarge the review surface. Bun's binary patch delivery is unsuitable here, so the original JS cleanup patch becomes a verified package input; watchdog reloads and same-thread timeouts cannot repair or interrupt a synchronous core spin.
