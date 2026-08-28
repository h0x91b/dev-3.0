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

**The code leaves the query.** `getAccessUrl` always mints a one-time QR token now
(`src/bun/remote-access-server.ts`). The browser gets a sign-in screen
(`src/mainview/components/RemoteSignIn.tsx`) with a masked field; on success the existing
HttpOnly session cookie takes over exactly as before. `RemoteSession.submitAccessCode`
(`src/mainview/remote-session.ts`) is the path out of the terminal `expired` state.

**But typing it every time is the reason it was in the URL to begin with**, and the session
cookie only lasts 24 hours, so a phone left alone over a weekend asks for 30 characters
again. So the code also gets a **bookmarkable sign-in link**: the access URL with the code
in its **fragment** (`src/shared/remote-sign-in-link.ts`, `#code=…`). A fragment is resolved
by the browser and never put on the wire — no tunnel log, no proxy access log, no Referer —
which is precisely the guarantee `?token=<code>` could not make. The renderer lifts it off
`location.hash` and strips it with `replaceState` in the same pass as the QR token, and
tries it only **after** the cookie probe fails, so a returning visitor never spends an
exchange on it. `dev3 remote url` prints the link; the Remote Access modal copies it to the
clipboard on an explicit click and never renders it.

Two things the fragment does **not** buy, both stated in the CLI output and the settings
hint rather than glossed over: it is still part of the URL, so it enters the browser's own
history like anything else (the `replaceState` clears the entry, not the omnibox's memory of
it), and a bookmark holds the code for as long as the bookmark lives. That is the trade the
link exists to make. A bookmark is the user's own store, like a password manager; a proxy
log is not.

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

**A settings code below the minimum length is dropped, not honoured.** `getStaticCode()`
runs the code past `remoteStaticCodeError` (`src/shared/remote-static-code.ts`, owned by the
sibling hardening task) and returns null with a one-time log line if it fails. The Settings
field refuses to save such a code, but that check does not cover a hand-edited
`settings.json` or a code saved before the check existed, and `getStaticCode()` is the line
where such a string would silently become a working credential.

Dropped rather than thrown: the env source throws at boot, deliberately, but this source is
UI-editable and `startRemoteAccessServer` is a top-level await, so killing the app over a
settings field would leave the only fix inside the app that no longer starts. This is the
one place the "never refuse the code" premise bends, and it bends by ruling rather than by
drift — a code that never cleared the floor was never a valid credential, so this refuses an
invalid value rather than voiding a working one.

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
- **A bookmarked link is a permanent bearer URL.** Whoever reaches the bookmark — a shared
  device, a synced browser profile, a shoulder — is signed in. The link is opt-in and copied
  by an explicit action, and its hint says so in all three locales.
- **The sign-in field is always offered**, even on a host with no code configured, so a
  wrong guess there is indistinguishable from "no code exists". That is intentional: an
  endpoint answering "this install has a code" tells an unauthenticated visitor something
  they have no business knowing, and would hand a brute-forcer a target list.

## Alternatives considered

- **Keep the code in the query and strip it via `replaceState`.** Already what the renderer
  does for the QR token, and it does not help: the query still passed through the tunnel and
  any proxy before the page could run. The fragment is what fixes that half; `replaceState`
  is retained for the address bar.
- **Rely on the browser's password manager instead of a link.** Considered and rejected as
  the only mechanism: it is one tap rather than zero, and it depends on each browser
  deciding the form is a login form. The masked field already carries
  `autocomplete="current-password"`, so managers that do offer it still work — the link is
  the guarantee, autofill is the bonus.
- **Put the code in the QR image so a scan enrols permanently.** Rejected: the QR is the one
  thing on this screen people screenshot and share, and its current one-time token expires
  in 65 seconds. Carrying a permanent code there would turn a harmless screenshot into
  forever-access.
- **A `/auth/mode` endpoint so the sign-in screen only shows the field when a code
  exists.** Nicer UX on a host with no code, at the cost of publishing that fact to
  anyone who asks. Rejected.
- **Keep the tunnel refusal and fix only the env inconsistency.** Rejected by the premise:
  a code reachable over a tunnel is exactly the setup the feature exists for.
