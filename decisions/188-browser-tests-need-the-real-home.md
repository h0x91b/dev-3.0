# 188 — Browser-spawning tests must pass the real HOME

## Context

`src/mainview/utils/__tests__/artifactTemplateFileProtocol.test.ts` spawns a real headless
Chromium through `execFileSync` and asserts on `--dump-dom` output. It failed intermittently
with `ETIMEDOUT`, which looked like a load flake on a machine running several agents.

## Investigation

It is not load. `test-setup.ts` redirects `HOME`, `TMPDIR` and `XDG_CONFIG_HOME` into a
per-run sandbox so parallel worktrees cannot collide, which leaves the browser with no
profile. A cold Chromium profile was measured never completing a trivial `about:blank`
dump — over 50s, with or without `--no-first-run`, `--use-mock-keychain` and
`--password-store=basic` — while the user's warm profile answers in 0.6s. Measured side by
side inside one vitest process: sandbox `HOME` timed out at 20s, real `HOME` returned in
616ms. The same command run by hand outside vitest always took ~0.7s, which is what made
the cause look environmental.

A second, independent trap surfaced while fixing it: with the default `SIGTERM`,
`execFileSync`'s `timeout` is not a deadline, because the browser's process tree keeps the
stdout pipe open while shutting down. A 300ms budget was measured overshooting to 1.7s, and
that overshoot scales with load — a naive retry turned a 20s flake into a 200s hang.

## Decision

`dumpDom()` in that test spawns the browser with `env: { ...process.env, HOME: userInfo().homedir }`.
`userInfo()` reads the passwd entry rather than `$HOME`, so it recovers the real home even
inside the sandbox. Only the browser spawn sees it; everything the test writes still goes to
`tmpdir()`. Each attempt also passes `killSignal: "SIGKILL"` so its budget is a real
deadline, and there are two attempts (20s, 40s) as insurance against a genuine spike.

Any future test that spawns a browser, or any other tool that keeps state in the user's home,
needs the same treatment — the sandboxed `HOME` is otherwise invisible until the tool
mysteriously hangs.

## Risks

The browser reads and may write cache inside the user's real Chromium profile, so this one
test is not hermetic. That is deliberate: a hermetic cold profile does not work at all here.
It also means a corrupted user profile can fail the test; the failure mode is a loud
`ETIMEDOUT`, not a hang.

## Alternatives considered

- **A stable cached profile under the real home** — hermetic-ish and warm after first use, but
  it still writes outside the sandbox while adding a warm-up path to maintain.
- **A wider timeout only** — what the first attempt at this did. It cannot work: the cold
  profile never finishes, so no budget is large enough.
- **Skipping the test when the profile is cold** — removes the only coverage of the artifact
  starter under `file://`, which is exactly the thing that has broken before.
