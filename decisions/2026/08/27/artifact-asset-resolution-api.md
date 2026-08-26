# Resolve runtime artifact asset paths through `dev3Artifact.asset()`

## Context

The artifact viewer rewrites local asset references by regex over the **stored HTML text**
(`composeArtifactDocument` in `src/mainview/utils/artifactDocument.ts`), replacing relative paths
with copied data URLs before handing the document to a `sandbox="allow-scripts"` srcdoc iframe. An
`<img src="shots/x.png">` that `report.js` builds at load time is not in that text, so its relative
src survives untouched — and inside an opaque-origin iframe it resolves to nothing. The image is
simply broken, with no error an author can act on, while the same report opens fine over `file://`.

The starter's own example report renders most of its content from script, so "put the data in
`report.js`" is exactly the habit the template teaches. The template dug this hole for its own users.

## Investigation

Reproduced with the real `composeArtifactDocument` output inside a `sandbox="allow-scripts"` srcdoc
iframe: an image declared in `index.html` rendered, and two images injected by `report.js` — one
built from a bare relative path, one from the same path — both stayed broken placeholders.

## Decision

Two changes, one API and one safety net:

- `composeArtifactDocument` injects `window.__dev3ArtifactAssets` (asset name → data URL) into the
  document head, next to the CSP and the find bridge.
- `app.js` exposes `dev3Artifact.asset(path)` (`assetUrl`), which canonicalizes the path the same way
  `assetKey()` does and returns the mapped data URL, or the path unchanged when there is no map —
  so `file://` and the extracted ZIP behave exactly as before. This is the documented path, in
  `AUTHORING.md` under "Preview and share".
- The injected script also runs a `MutationObserver` that heals a bare relative `src` on `img` and
  `source` elements added after load. Artifacts published before the helper existed keep rendering,
  and an author who never reads the rule does not ship a broken report.

## Risks

The observer watches `document.documentElement` for `childList`, `subtree`, and the `src` attribute.
It is a no-op unless the raw `src` canonicalizes to a name present in the map, and rewriting to a
`data:` URL cannot re-trigger it (the scheme test rejects it), so it cannot loop. It covers nothing
beyond `img`/`source` — CSS built in JS, `fetch()`, canvas, and download links still need `asset()`,
which is why the rule is documented rather than replaced by the observer.

## Alternatives considered

**A documented rule alone** ("an src injected by report JavaScript is not rewritten") — cheapest, but
it leaves every already-published artifact broken and turns one more silent failure into something
the author must remember. **Rewriting at asset-copy time in `shared-artifacts.ts`** — the path only
exists at runtime, so there is nothing to rewrite. **Giving the iframe a real origin** — would undo
the sandbox that is the artifact security boundary.
