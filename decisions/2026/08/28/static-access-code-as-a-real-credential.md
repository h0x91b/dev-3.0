# The static access code is a permanent credential, not a dev-only shortcut

## Context

The remote-access static code was built as a local-dev convenience and the code treated it
as one. Three consequences, all wrong for what it actually is:

1. `getAccessUrl` put the code straight into the URL as `?token=<code>`. Fine for the
   rotating QR token, which burns on first use; ruinous for a permanent credential, which
   then lives in browser history, the address bar, and every proxy or referrer log on the
   way.
2. `handleAuthExchange` disabled the QR/JWT path entirely whenever a code was set. A box
   with a code could not onboard a new device by scanning.
3. `dev3 remote --static-code=…` refused to boot without `--no-tunnel`, blocking the most
   ordinary setup there is (sign in to a headless box from a phone). The gate also read
   only the flag, so the identical combination arriving via an exported
   `DEV3_REMOTE_STATIC_CODE` was waved through in silence.

The premise, decided with the user: a static access code is **permanent and multi-use by
design** — one long code, any number of sign-ins, any number of devices. It is never
rotated, voided, expired, refused, or disabled. Reuse is the feature. The two real risks
are that it can be guessed (handled separately, see
`decisions/2026/08/28/throttle-remote-auth-exchange.md`) and that it leaks through the URL.

## Decision

**The code leaves the URL.** `getAccessUrl` always mints a one-time QR token now
(`src/bun/remote-access-server.ts`). The browser gets a sign-in screen
(`src/mainview/components/RemoteSignIn.tsx`) with a masked field; on success the existing
HttpOnly session cookie takes over exactly as before. `RemoteSession.submitAccessCode`
(`src/mainview/remote-session.ts`) is the only path out of the terminal `expired` state.

**Both credentials stay live.** `handleAuthExchange` accepts the code when it matches and
otherwise falls through to the QR exchange, so a stale or consumed QR token is still
rejected on its own merits while a configured code can no longer shadow a fresh scan.

**The CLI warns instead of refusing.** `shouldWarnAboutPublicTunnel` /
`STATIC_CODE_PUBLIC_TUNNEL_WARNING` (`src/cli/remote-static-code-notice.ts`) print one line
from both `collectRemoteEnv` (`src/cli/commands/remote.ts`) and `buildExecStartArgs`
(`src/cli/commands/remote-service.ts`). The notice reads the env alongside the flag, so the
two spellings stop disagreeing.

**It is a normal setting.** `GlobalSettings.staticAccessCode`, edited in Settings → System,
stored in plain text like every other field. `getStaticCode()` reads
`DEV3_REMOTE_STATIC_CODE` first, then the setting. The Remote Access modal reports
*whether* a code is set (`staticCodeActive`) and warns while the tunnel is up — never the
code itself.

### Two things deliberately not done

**No system keychain.** Decided explicitly. The code sits in the settings file next to
everything else. A keychain would split the credential across two stores that headless and
Docker installs cannot both reach, for a threat model (local disk read) that already
exposes the session secret and every project path anyway.

**No session revocation.** Changing or clearing the code does **not** invalidate sessions
that are already signed in — the new code applies to new sign-ins only. This is a choice,
not an oversight: revocation means either dropping every live session on an unrelated
settings edit, or building a per-session ledger this codebase does not have. A user who
needs to eject a device today restarts the server, which rotates the JWT secret.

## Risks

- **The code is now the only thing a guesser has to get past** — the URL no longer carries
  it, so brute force against `/auth/exchange` is the whole attack. That is why the
  length floor and the throttle land alongside this (seq 1734).
- **No revocation** means a leaked code stays valid until the owner changes it *and*
  restarts the server. Documented in `docs/remote-access.md` and in the settings hint.
- **The sign-in field is always offered**, even on a host with no code configured, so a
  wrong guess there is indistinguishable from "no code exists". That is intentional: an
  endpoint answering "this install has a code" tells an unauthenticated visitor something
  they have no business knowing, and would hand a brute-forcer a target list.

## Alternatives considered

- **Keep the code in the URL but strip it from history via `replaceState`.** Already what
  the renderer does for the QR token, and it does not help: the URL still passed through
  the address bar, the tunnel and any proxy before the page could run.
- **A `/auth/mode` endpoint so the sign-in screen only shows the field when a code
  exists.** Nicer UX on a host with no code, at the cost of publishing that fact to
  anyone who asks. Rejected.
- **Keep the tunnel refusal and fix only the env inconsistency.** Rejected by the premise:
  a code reachable over a tunnel is exactly the setup the feature exists for.
