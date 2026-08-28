# Throttle /auth/exchange, and refuse a static code shorter than 8

## Context

`--static-code` / `DEV3_REMOTE_STATIC_CODE` replaces the rotating single-use QR
token with a fixed one, so that several devices and browsers can enrol without
scanning a fresh QR from the host each time. That reuse is the feature and stays
— the code is a long-lived, multi-use credential by design.

The weakness was that it could simply be guessed. The CLI accepted a 4-character
code (~1M combinations), and `POST /auth/exchange` had no attempt counter, no
delay and no 429 — a script could walk the whole space. `checkOrigin` is not a
defence here: it returns `true` when a request carries no `Origin` header, which
a non-browser client just omits.

## Decision

**Minimum length is 8** (`MIN_REMOTE_STATIC_CODE_LENGTH`,
`src/shared/remote-static-code.ts`), enforced by the one validator that the
`dev3 remote` flag parser, the systemd unit writer, and the server all call.

**A weak code set straight into the env is a hard startup failure**, not a
silent downgrade: `assertStaticCodeStrongEnough()` runs first thing in
`startRemoteAccessServer()` and throws. Both CLI entry points already reject a
short code at flag-parse time, so reaching the server with one means the env var
was set directly (Docker, a hand-written unit, an exported shell) — unattended
contexts where a log line goes unread. Quietly falling back to rotating QR
tokens would break the caller's saved URL with a plain 401 that reads as "auth
is broken" rather than "your code is too short". The error message names the
cause and never contains the code itself, because it also goes to the log.

**The throw is scoped to the env, and only the env.** The gate reads
`process.env.DEV3_REMOTE_STATIC_CODE` directly rather than `getStaticCode()`,
which is about to grow a settings-backed fallback (`staticAccessCode`, seq 1735
/ PR #1586). `startRemoteAccessServer()` is a top-level `await` on the app's
boot path, so a typo in a settings field would otherwise take the whole app
down, with the only fix living inside the app that no longer starts. The rule
for any UI-editable source is the opposite one: reject the **value** — drop it,
log it, show the error in its own field — never the boot. A source-level test
pins the read, because the second source does not exist in this branch yet.

**Failed exchanges are throttled** (`src/bun/remote-auth-rate-limit.ts`):
5 failures per 30 s per key, then 429 with `Retry-After`, checked *before* the
submitted credential is compared. Three properties do the work:

- **Only failures count, and a success clears the record.** A device that knows
  the code is never delayed, so several devices still enrol back to back, and a
  typo before the right code costs nothing.
- **The key is the socket peer address** (`server.requestIP(req)`), never
  `X-Forwarded-For` / `CF-Connecting-IP`. Those headers are attacker-controlled
  on a direct connection, so keying on them would hand out a fresh budget per
  request — a fake defence. The consequence is deliberate: behind a tunnel every
  request shares one peer address, so all tunnel traffic shares one budget.
- **A block always expires.** The window is 30 s and never escalates, so the
  worst an attacker can inflict on the owner is a half-minute wait on a new
  enrolment — and only when they share a bucket (i.e. behind the tunnel).
  Existing devices are untouched: `/auth/refresh` carries a signed cookie, is
  not guessable, and is deliberately left unthrottled so live sessions survive
  an attack in progress.

At 5 tries per 30 s, one bucket yields ~14 400 guesses a day against a space of
36^8 ≈ 2.8·10^12 for an 8-character alphanumeric code. Guessing stops being a
strategy.

## Risks

- **Shared bucket behind a tunnel.** An attacker hammering the public URL can
  make the owner's *new* enrolment wait up to 30 s. Accepted: bounded, never
  permanent, and existing sessions keep working. Note the CLI already refuses to
  combine `--static-code` with a public tunnel, so this is mostly the BYO-tunnel
  and QR-token case.
- **A desktop app whose environment carries a short code now fails to start**
  instead of booting without remote access. That is the point of the loud
  failure, but it is a behaviour change for anyone who exported a 4-7 character
  code.
- **In-memory throttle state.** A restart clears it. Restarting the server is
  not something a remote attacker can do, so the reset is not a bypass.

## Alternatives considered

- **A delay instead of a 429** — sleep before answering a failed attempt. Does
  not stop a parallel attacker: 1000 concurrent guesses are all still evaluated,
  just slowly. Rejected.
- **A global counter across all callers** — catches IP rotation, but hands an
  attacker a way to freeze the owner out from anywhere. Rejected; a per-peer
  budget plus a socket-derived key covers the realistic cases without the
  lockout.
- **Keying on `clientIp` (the header-derived value already used for logging)** —
  reads better through a tunnel, but is spoofable on a direct connection, which
  is exactly the case that matters on LAN. Rejected.
- **Making the static code single-use or rotating it** — would defeat its
  purpose; enrolling several devices from one code is why it exists.
