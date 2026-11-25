# Renderer and backend tests run on vm pools, guarded by a realm snapshot

## Context

`bun run test` cost ~640 s of CPU per run on a 16-core box, and the renderer suite
(`vitest.config.ts`, 534 files) was ~70% of it: measured alone at 4 workers it took 394 s CPU,
of which ~66 s was building a fresh happy-dom window per file and ~60 s re-running setup.
The backend suite (`vitest.config.bun.ts`, 719 files) took 160 s CPU, much of it spawning a
fresh fork per file.

## Investigation

Same box, same 4-worker cap, back-to-back runs (load average 12–30, so absolute seconds are
noisy; CPU agreed within ~7% between repeats):

| Renderer pool | Wall | CPU (user+sys) | Result |
|---|---|---|---|
| `forks` (default) | 97 s | 394 s | green |
| `threads` | 90 s | 368 s | green |
| `forks` + `isolate: false` | >600 s | — | hung, killed |
| `vmThreads` | 62–64 s | 200–204 s | 3 files red, then green after the fixes below |

| Backend pool | Wall | CPU (user+sys) | Result |
|---|---|---|---|
| `forks` (default) | 73 s | 160 s | green |
| `forks` + `isolate: false` | 440 s | — | 1255 tests red |
| `vmForks`, no guard | 79 s | 113 s | 9–48 tests red, order-dependent; wrote files into `./undefined/` once `HOME` leaked away |
| `vmForks` + guard | 57 s | 103 s | green; shuffled seeds 1–3 green except load-spike timing flakes (see Risks) |

vitest forces `isolate: false` for vm pools (`resolved.isolate = false` in its config
resolution), so one happy-dom window is shared by every file a worker runs. A two-file probe
confirmed it: a prototype property and a global set in file A were visible in file B under
`vmThreads`, and not under `forks`. Two of the three failures were exactly that
(`HTMLElement.prototype.getBoundingClientRect` / `scrollIntoView` patched by an earlier file);
the third returned a Node-realm `Response` whose body happy-dom could not read.

## Decision

`vitest.config.ts` sets `pool: "vmThreads"` and `vitest.config.bun.ts` sets `pool: "vmForks"`
(forks, because backend tests `process.chdir`). `test-realm-guard.ts` (repo root) snapshots the
own property descriptors of every global constructor and prototype (DOM classes included),
`globalThis`, `console`, `process`, `process.stdout/stderr`, `navigator`, `document`,
`location`, plus `process.env` and `cwd`, before a file's code runs, and tracks every timer the
file arms. A fork used to take pending timers down with it; in a shared worker a 10 s watchdog
from one file fired inside a later one and failed CI, so the guard cancels them at file end. Both setup files restore
the snapshot (and clear both storages) in an `afterAll` that runs after the file's own hooks.
`src/mainview/__tests__/test-realm-guard.test.ts` pins the restore and the wiring. Three
shuffled-order renderer runs (`--sequence.shuffle.files`, seeds 1–3) were fully green. The CLI
config stays on `forks`: `vmForks` broke 279 CLI tests even with the guard, and that suite
costs only ~18 s of CPU.

## Risks

- Backend tests that wait on real timers or fs watchers (`pi-status-extension`,
  `agent-message-log-watch`, `omp-status-extension`) failed on load spikes (load average
  90+), the same timing class that already flaked on `forks` before this change.
- Shared state the guard does not snapshot (module-level state in an externalised
  `node_modules` package, a never-cleared timer on the shared window) can still leak and show
  up as an order-dependent flake. Reproduce with `--sequence.shuffle.files --sequence.seed=N`.
- vm pools are documented by vitest as leaking memory over long runs; peak RSS stayed ~1.5 GB.
- Host-realm objects (Node `Response`, `Buffer`) behave differently inside the vm context;
  stubs should return plain objects.

## Alternatives considered

- `threads`: safe, but only −7% CPU.
- `isolate: false` on forks: does not finish.
- Moving non-DOM files to `environment: node`: saves only the env build for ~160 files
  (~20 s), and the vm pool already removes almost all of the environment cost.
