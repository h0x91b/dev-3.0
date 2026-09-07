# Artifact links: allow-popups plus base target, minus the in-page anchors

## Context

Every link in a rendered artifact was a dead click. The document lives in a
`srcdoc` iframe sandboxed with `allow-scripts` only (`ArtifactFrame.tsx`), so
top navigation is forbidden and `_blank` needs `allow-popups`.

## Investigation

Measured in a real sandboxed frame (headless Chromium, the composed document
served from a throwaway host page), not reasoned about:

- `allow-popups` + `<base target="_blank">` opens external links in a browser
  tab, as intended.
- The same default catches `#section`. A `srcdoc` document inherits the PARENT
  page's URL as its base URL, so an anchor click opened a tab on the app's own
  URL (`…/#bottom`) instead of scrolling. Without `allow-popups` the identical
  click was refused outright: `Blocked opening … because the request was made in
  a sandboxed frame whose 'allow-popups' permission is not set`.
- A relative `report.html` resolves the same way and opens a tab on an app URL.
  Left as-is: artifact assets are inlined at compose time, so a relative *page*
  link has no destination either way, and taking it back would cost more code
  than the case is worth.

## Decision

Two lines plus one small script:

- `ArtifactFrame.tsx` — `sandbox="allow-scripts allow-popups"`.
- `composeArtifactDocument` injects `<base target="_blank">` (no href, so a
  report's own `<base href>` still sets the base URL).
- `src/mainview/utils/artifactLinks.ts` — an injected click handler that takes
  `a[href^="#"]` back off that default: `preventDefault` plus `scrollIntoView`
  on the target, by id or `name`, percent-decoded; a bare `#` scrolls to the top.

## Risks

`allow-popups` also lets report code call `window.open` for real. That is the
price of the two-line route; the frame keeps its opaque origin, and the popup it
opens inherits the sandbox. The desktop path (a popup from a nested sandboxed
frame reaching the `new-window-open` intercept in `window-manager.ts`, which
forwards http(s) to `Utils.openExternal`) is verified in a browser, not yet in
the Electrobun shell.

## Alternatives considered

Intercepting every click and posting the URL to the viewer, which opens it from
its own origin — the desktop-proven path terminal links already use. It works
and needs no sandbox change, but it is ~5× the code (a link classifier, a
`window.open` patch, a host handler) for what a browser default does for free.
