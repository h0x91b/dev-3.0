# Task card and sidebar identity glyphs on an internal `taskMarkers` slot

## Context
Phase 7's first item in the GUI-on-plugins plan (`decisions/2026/11/21/gui-plugin-slots-and-api-versioning.md`):
the "Task card / sidebar marker" contribution slot under the bible §5.6 identity-marker contract — a passive
glyph, no action, at most one extension marker (§9). Internal first: built-ins only, no manifest kind, no public
service, no API version bump. The card's inline action strip is full (§9) and is not touched.

## Decision
- `src/mainview/task-markers/`: a contribute-kind `TaskMarkerRegistry`. An item has a required `when(scope)`, a
  `label(t, scope)` (its accessible name) and optional `surfaces` (`card`, `sidebar`; both when omitted).
- Moved onto it: `NativeBackendMark` (card and sidebar row) and `ForeignCodeMark` (card only, as before). They are
  the two glyphs that state a persisted property of the task and meet every clause of §5.6.
- Not markers: `CompletionOfferMark` and the keep-alive glyph are live status (the latter danger-toned); the
  scratch and automation glyphs carry no accessible name; the role band hosts a filter; PR-review and draft are
  text badges. They stay inline.
- Performance (2400-task boards): one `useSyncExternalStore` in `TaskMarkersProvider` at the app root; a card
  reads the entries from context. `when` runs before anything mounts, so a card no marker applies to adds no
  fiber beyond `<TaskMarkers>`; a sidebar row keeps an empty `<TaskMarkerItems>`. No wrapper element, so the DOM is unchanged.
- `placeTaskMarkers` shows every applicable built-in, then the first applicable extension marker, after them.
- A throwing `when` or `label` hides that marker and is logged once per marker id, not once per card per
  render; a throwing `component` is caught by its own boundary.
- The sidebar row's explicit `aria-label` overrides its descendants, so the row folds each shown marker's
  `label` into its own name instead of special-casing the native backend.

## Risks
- Outside the provider (a surface rendered alone, tests) the entries are read once, not followed. Every app
  mount is under the provider; tests install the built-ins with `task-markers/__tests__/install-builtins.ts`.
- Cordis applies plugins a few microtasks after start, so the very first frame may draw no marker; the provider
  re-renders once they register.
- The Task View breadcrumb still renders `NativeBackendMark` directly: it is not a card or row surface.

## Alternatives considered
- `SlotItems` per card: a registry subscription and a wrapper `div` per card, plus error boundaries for markers
  that do not apply. Rejected for the board's size.
- Encoding the surface in `when` instead of `surfaces`: works, but hides where a marker can appear.
