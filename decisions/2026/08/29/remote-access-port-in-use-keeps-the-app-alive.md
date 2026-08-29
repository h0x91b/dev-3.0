# Remote access on a taken port: keep the app, keep the pin, show the failure

## Context

`src/bun/index.ts` started remote access with an unguarded top-level `await`, and
`Bun.serve` throws **synchronously** on `EADDRINUSE`. Verified on the packaged dev
`.app` with a real occupied port: the log stops one line after `Main window created`,
Electrobun prints `Uncaught exception in worker`, and **the whole app process exits**.
Everything sequenced after that call is lost — lifecycle rehydration plus the merge,
PR, port-scan, resource, rate-limit, automations, scheduled-launch, scheduled-message
and focus-tracker services, and `=== dev-3.0 ready ===`.

The process handlers at `index.ts:65/74` do *not* catch it in the Electrobun embedding
(they do under a plain `bun file.ts`), so nothing logs it where a user would look. The
window is created ~0 ms earlier, so the symptom is a flash and then nothing.

This became urgent because PR #1576 adds a settings field that lets the user pin the
port by hand — a field that turns a rare Docker/CLI condition into a typo away.

## Investigation

Reproduced by squatting the port with a second `Bun.serve`, then
`DEV3_PORT0=<port> bun run dev --qa`. A free-port control run on the same command
enumerates exactly what dies. `headless-entry.ts` already wraps the same call, but only
to kill an inherited `cloudflared` before rethrowing — headless still dies, which is
correct there because remote access *is* that process.

## Decision

`startRemoteAccessServerGuarded` (`src/bun/remote-access-server.ts`) wraps the throwing
start, records a `RemoteAccessStatus`, and returns it instead of throwing;
`src/bun/index.ts` calls that form. Headless keeps calling the throwing one.

Three properties, and each rules out a cheaper option:

- **Boot continues.** A failure of remote access costs remote access only.
- **The pin is never silently traded for another port.** A pin exists to keep an
  external URL or a Docker mapping valid; serving elsewhere would look like success
  while breaking the thing the pin was for.
- **The failure is visible for as long as it lasts**, not announced once. A status row
  in Settings → System names the port and offers *Try again*
  (`retryRemoteAccess` re-attempts the bind with no app restart); the Remote Access
  modal shows the same row instead of a QR, because with nothing listening the port is
  0 and the code would encode `http://host:0/`.

A bare `try/catch` was explicitly rejected: it converts a loud failure into a silent
one, and the settings field would keep showing a port that does nothing.

## Risks

The failure now persists as UI state rather than a crash, so a user who ignores the row
runs without remote access indefinitely — accepted, since the alternative is an app that
will not start. `retryRemoteAccess` re-enters `startRemoteAccessServer`, which re-runs
`initSecret()` and re-reads the static code; both are idempotent, but a future
side-effecting step added there would run twice.

## Alternatives considered

- **Fall back to a random port and toast once.** Cheapest, and wrong: it breaks the
  Docker mapping or saved phone URL the pin existed for, quietly.
- **Halt startup deliberately with a visible error.** Native dialogs are banned here
  (the app also runs in a browser), and the only place to fix the setting is the app
  that would no longer start — the same trap `assertStaticCodeStrongEnough` documents.
- **Retry on a timer until the port frees.** Adds a clock without removing the need for
  the UI; the user still has to be told.
