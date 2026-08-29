# Public assets are enumerated from disk, not hand-listed in the copy map

## Context

`electrobun.config.ts`'s `build.copy` is an **allow-list**, not a directory copy:
Electrobun copies exactly the entries named there. Vite, meanwhile, copies
everything in `src/mainview/public/` to the dist root, and `index.html` links
those files by absolute path. The two lists have to agree, and nothing enforced
that they did.

## Investigation

The mismatch has shipped twice. The favicons were missing first and were added
by hand in an unrelated PR (`42001e0a`). Then `sw.js` and `manifest.webmanifest`
landed in `public/` (#1540) without a copy entry, so no packaged build ever
contained them: the remote server's SPA fallback answered `/sw.js` with
`index.html`, and a service worker served as `text/html` cannot register — Web
Push enrolment failed on every packaged install with Safari's generic "could not
update push notifications".

It survived review because `BrowserNotificationsSetting` returns null under
Electrobun, so the push UI does not exist in the desktop app at all; reproducing
it needs remote mode, a valid certificate, a stable origin and iOS
Add-to-Home-Screen.

## Decision

`publicAssetCopyEntries()` in `electrobun.config.ts` reads
`src/mainview/public/` at config-eval time and spreads one `dist/<name>` →
`views/mainview/<name>` entry per file into `copy`; the four hand-written favicon
lines are gone. `src/bun/__tests__/electrobun-config.test.ts` asserts every file
in that directory has an entry, so the next asset dropped in fails the suite
rather than a phone. `serveStatic` also learned the `.webmanifest` MIME type,
which was falling through to `application/octet-stream`.

## Risks

The config now touches the filesystem while being evaluated, and it is evaluated
twice: at build time from the repo, and again inside the packaged app, which
imports it from `src/bun/index.ts` for the version and the CLI binary name. In
the bundle there is no `src/`, so the first version of this crashed the app on
boot with ENOENT. The scan is therefore guarded by `existsSync` and returns an
empty map where the directory is absent — inert, because nothing reads
`build.copy` at runtime. The build-time contents are what the test asserts.

## Alternatives considered

Adding the two missing lines by hand: the same fix that was applied to the
favicons, and it leaves the next asset just as exposed. A test parsing
root-relative `href`/`src` out of the built `index.html` was the original
proposal, but it misses `sw.js` entirely — the service worker is registered from
JavaScript and never referenced by the HTML.
