# 164 — Shim `localStorage` in the mainview test setup for Node 26

## Context

On Node v26.4.0 the whole mainview vitest leg (`bun run test`) died — ~1600 failures,
every React-rendering test throwing `Cannot read properties of undefined (reading
'getItem')` from `readLocale()` in `src/mainview/i18n/context.tsx`. Nothing in the repo
had changed; the same failures reproduce on a clean checkout of `main`.

## Investigation

Node ≥ 22 ships an experimental global `localStorage` that only becomes a real store
when the process is started with `--localstorage-file`; otherwise it evaluates to
`undefined` and Node prints `ExperimentalWarning: localStorage is not available because
--localstorage-file was not provided`. That global shadows happy-dom's, and it does so
on **both** `globalThis` and `window` — probing inside a test showed
`typeof localStorage === "undefined"` in both scopes while `sessionStorage` (which Node
does not define) stayed a working happy-dom `Storage`. Passing
`NODE_OPTIONS=--localstorage-file=...` unblocks the suite but is the wrong fix: Node's
store is a single file shared by every test file in the run, so state leaks across files
and ~8 files with storage-persistence assertions start failing each other.

## Decision

`src/mainview/test-setup.ts` installs a small in-memory `Storage` on `globalThis` and
`window` when `globalThis.localStorage` is undefined. `setupFiles` runs once per test
file, so each file gets a fresh store — the same per-file isolation happy-dom's storage
gave us. The properties are defined `configurable`/`writable` so tests that stub
`window.localStorage` themselves keep working. Guarded by
`src/mainview/__tests__/test-setup.test.ts`.

## Risks

The shim is not a real happy-dom `Storage` instance, so an `instanceof Storage` check or
a `storage` event expectation would not be satisfied (neither is used today). If a future
Node makes the built-in global a working store, the `typeof === "undefined"` guard simply
stops firing and happy-dom/Node behaviour takes over.

## Alternatives considered

- **`NODE_OPTIONS=--localstorage-file` in the test scripts** — rejected: one shared file
  for the whole run breaks per-file isolation and leaves stale state on disk between runs.
- **Pin a Node version for tests** — rejected: doesn't help anyone already on Node 26, and
  the same global lands in every future Node.
- **Make `readLocale()` defensive** — rejected: it would paper over the environment gap at
  one call site while every other `localStorage` consumer stays broken in tests.
