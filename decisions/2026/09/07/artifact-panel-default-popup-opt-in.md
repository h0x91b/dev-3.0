# The artifact panel is the default again; the popup becomes one opt-in setting

## Context

`decisions/2026/09/05/artifact-popup-replaces-resizable-panel.md` (PR #1656) deleted the docked,
drag-resizable artifact panel and made the centred popup the only presentation, because resizing
the panel could wedge the whole UI. Two days of use produced the opposite verdict from the people
who never hit that freeze: the panel is what they want, because an artifact is meant to be read
*beside* a live terminal, and the popup covers exactly the thing the report is talking about.

Arseny's ruling on 2026-09-07: most users prefer the panel on the right and do not experience the
freeze; the popup stays available as an explicit option for those who do — himself included.

Two facts this record must not blur:

- **The freeze cause is still unestablished.** Seq 1797 recorded freezes on resize *and* on close,
  and `decisions/2026/09/05/artifact-viewer-back-in-the-page.md` gave up the webview process
  isolation that had contained it. The popup is a different presentation, not a fix, and neither
  the setting's copy nor this record claims otherwise.
- **The native webview host is not coming back.** Seq 1802's removal (PR #1659) stands: one
  sandboxed `srcdoc` iframe, no native layer, no mask scanner, no webview-only bridge.

## Decision

Both presentations are product modes served by **one** `TaskArtifactViewer`, and the viewer stays
mounted by `App` for every entry point. What changes is where it renders:

| | Docked panel (default) | Popup (opt-in) |
|---|---|---|
| Chosen by | no stored preference, or `openArtifactsInPopup: false` | `openArtifactsInPopup: true` |
| Container | `createPortal` into the slot the workspace pane publishes | centred card over a scrim, as shipped |
| Modality | not modal — the terminal beside it is live | modal: `role="dialog"`, `aria-modal` |
| Escape / ⌘F / arrows | only while focus is inside the panel | unconditionally, unwound by the overlay-layer stack |
| `<html data-artifact-viewer>` | absent (set only in fullscreen) | `"open"` |

The slot is a module, not a prop chain: `utils/artifact-dock.ts` holds the one element the pane
publishes, and the viewer reads it through `useSyncExternalStore`. React cannot reparent a
subtree, so this is what makes the two modes one implementation — and it buys two behaviours the
brief asked for directly. **Flipping the preference while an artifact is open re-hosts the same
mounted viewer**, so the loaded document, the selected version, the find query and an unsent
`sendToAgent` draft all survive. And because there is exactly one slot and one viewer, a task
switch or a mode flip cannot leave a second, hidden artifact instance behind.

Everything the panel needs is restored in `TaskWorkspacePane` as it was before PR #1656 — the
persisted `dev3-artifact-panel-width`, the pointer-capture resize session with its ghost line and
drag shield, the `role="separator"` keyboard-resizable handle, and the clamp-on-container-resize
effect — plus `dockArtifact`, threaded App → `ProjectView` → `TaskWorkspaceView` → pane.

The pane refuses the slot in three cases, and each refusal is a fallback to the popup rather than
a missing viewer: while the inline diff owns the surface, on a narrow viewport (a 360px-minimum
panel is unusable on a phone, and the popup card already fills a small viewport — bible §12.3),
and in immersive terminal fullscreen, which is deliberately chrome-free. The archived-task modal
and a toast for a task that is not on screen get the popup for the same structural reason: nothing
publishes a slot there.

One switch, `Settings → Tasks & Board → Open artifacts in a popup`, default off
(`openArtifactsInPopup` in `GlobalSettings`). Both booleans are stored: an explicit `false` is the
user choosing the panel, not the absence of a choice.

## Risks

- **The resize path is back, and with it the freeze nobody has explained.** That is the trade the
  ruling accepted: the mitigation shipped in the original panel (a ghost line follows the pointer,
  the real width lands once on pointer up) is restored with it, and anyone who freezes has a
  one-click way out that the previous shape did not offer. If the freeze is ever reproduced and
  traced, that investigation owns the panel, not this record.
- **Flipping the preference does move a live surface out from under the pointer.** It is a
  settings screen action, so the artifact is not being read at that moment.
- The stored panel width that PR #1656 declared dead data is read again, so anyone who dragged
  the panel before 2026-09-05 gets that width back.

## Alternatives considered

- **Two viewer components, one per presentation.** Rejected: the header alone carries eight
  controls, version switching, find, theme, download, browser hand-off and the draft notice — a
  second copy would drift, and the repo does not keep parallel paths.
- **Keep both mounted and hide one.** Exactly the orphaned hidden instance the brief forbids: two
  iframes loading the same document, two find states, two draft channels.
- **A three-way "auto / panel / popup" control**, matching the diff-layout row's shape. Rejected:
  the ask is one checkbox, and "auto" would need a rule nobody can state while the freeze is
  unexplained.
- **Restore the panel without the drag handle** (fixed width, keyboard-only). Rejected for the
  same reason as in PR #1656's own alternatives, from the other side: the user asked for the
  panel that was useful, and its width was part of that.
