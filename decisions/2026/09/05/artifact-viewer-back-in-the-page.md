# The artifact viewer renders in the page again — the separate webview is gone

## Context

`decisions/2026/08/31/artifact-viewer-in-its-own-webview-process.md` moved the
artifact document into an `<electrobun-webview>` so a runaway artifact could not
freeze the app window. That host is a **native layer the OS paints above the whole
window**: it ignores `z-index`, `overflow` and stacking order, so keeping app
overlays visible over it needed a runtime mask scanner, a 200 ms poll and a
`toggleHidden` policy for a zero-sized viewer.

Two things then changed under it:

- `decisions/2026/09/05/artifact-popup-replaces-resizable-panel.md` (PR #1656)
  made artifacts open as a centred popup over a scrim. The masking now has to hold
  a hole open for a modal card, its scrim, and everything drawn on top of both.
- The masks were the one part of that change never measured on a real native
  layer, and it shows: a screenshot from 2026-09-05 11:43 has an opaque
  rectangle sitting over the top-right of the popup where the mask geometry and
  the native layer disagree.

Arseny's ruling on 2026-09-05: remove the separate view now that artifacts open
centrally. This record covers the removal, not the ruling.

## Decision

`components/ArtifactFrame.tsx` is one host again — the sandboxed `srcdoc` iframe —
and keeps the same `post` / `onMessage` / `onReady` surface, so
`TaskArtifactViewer` is unchanged apart from no longer choosing a transport.
Deleted outright, with every caller migrated in the same change:

| Gone | What it did |
|---|---|
| `utils/artifactTransport.ts` (+ test) | Picked `webview` on desktop macOS, `frame` everywhere else |
| `utils/artifactOverlayMasks.ts` (+ test) | Scanned fixed overlays and tagged them so the tag could punch holes |
| `ArtifactFrame`'s webview branch | The imperatively built tag, its 200 ms sync poll, `toggleHidden`, `addMaskSelector` |
| `artifactChannel`'s `webview` branch, `receive()`, `republish`, `artifactChannelDeliveryScript` | The event-bridge envelope out and `executeJavascript` in |
| `ARTIFACT_OVERLAY_ATTRIBUTE` on `ArtifactSearchBar` | Punched a hole for the find bar; ordinary CSS stacking does it now |

The channel is `parent.postMessage` out and a `message` listener in. That also
retires the theme-republish hack: under the iframe the host posts straight into
the artifact's own window, so an artifact already on disk that listens with a
plain `window.addEventListener("message")` — every report the shipped template
ever produced — hears the theme without help. `composeArtifactDocument` lost its
`transport` argument; the document it produces is otherwise byte-identical, so
stored artifacts, version switching, find, save-image, downloads and
`window.dev3.sendToAgent` are unaffected.

Remote (browser) mode already ran this exact path and does not change at all.

## Risks

- **Process isolation is gone.** The artifact shares the app window's WebContent
  process and its main thread again, so an artifact that wedges its own JS thread
  wedges the app — exactly the freeze Seq 1755 recorded. That containment was a
  macOS-only benefit (Linux ships `bundleCEF: false`, Windows was never measured),
  and it is now nobody's. The underlying runaway-loop bug stays open.
- **This is not a freeze fix and must not be read as one.** Seq 1797 reports the
  original freezes happened on artifact resize *and on close*, that the cause is
  still not established, and that removing the splitter therefore proves nothing
  about it. Returning to the iframe shares the renderer's fate again.
- On the other side of the ledger, the removal also drops the upstream hole
  recorded on Seq 1762: Electrobun 1.18.1 splices a child's `host-message`
  `detail` into the host page as raw JS, so a sandboxed webview child could run
  script **in the host page** — something a sandboxed `srcdoc` iframe cannot do.
  Agent-written artifact HTML no longer has that reach.

## Alternatives considered

- **Keep the webview and fix the mask geometry for the popup.** Chasing a native
  layer's rectangles against a centred modal, its scrim, toasts and menus — the
  masks had already failed once unmeasured, and the ruling was to remove the view.
- **Keep the webview only in fullscreen, iframe in the popup.** Two hosts for one
  surface, each with its own bug surface, and the repo does not keep parallel
  paths alive.
- **Keep the module and stop calling it.** That is a deprecated branch; this repo
  replaces rather than deprecates.
