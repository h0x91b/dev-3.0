# Artifact form controls are skinned on the element, not on `.field`

## Context

The artifact starter styled inputs only through `.field input, .field select`, and checkbox/radio glyphs only through `.check input`. `<textarea>` had no rule at all — not even in the `button, input, select { font: inherit; }` reset. A report that wrote a plain textarea (which `REFERENCE.md` explicitly invites for the send-to-agent flow) shipped a 20-column UA box in the UA font, next to a fully styled form.

## Decision

`src/assets/artifact-template/app.css` now hangs the shell off the elements — `input:where(:not(.choices__input)), textarea, select` — and leaves `.field` with the width only. The special types re-specify what they need further down: range, checkbox/radio glyphs, file, color, submit-like inputs. A plain `<select>` gets `appearance: none` plus its own caret, so it no longer needs `data-ui-select` to stop being native chrome.

Two mechanics make this hold and must survive any edit:

- **`:where()` keeps the base rules at element specificity (0,0,1).** That is what lets `.field`, `.table-tools`, `.check`, `.switch` and the per-type blocks win on their own details without `!important`. Replacing a `:where()` with a plain `:not()` raises the specificity and silently breaks the overrides.
- **The caret is two `linear-gradient` triangles, not a data-URI SVG,** because a data URI cannot read `--dev3-text-muted` and would need one hardcoded hex per theme. Consequently a shorthand `background:` anywhere downstream wipes the caret — `.table-tools` had to move to `background-color:` for exactly this reason.

Coverage is guarded by `src/bun/__tests__/artifact-template.test.ts` ("skins every standard control on the element itself"). The CSS size cap in the same file moved from 44 000 to 54 000 bytes; the shell stylesheet is not an authoring surface, and 49.5 KB is still ~20x under an inlined chart library, which is what that cap actually guards.

## Risks

`select[multiple] option:checked` uses a flat gradient because browsers ignore `background-color` there; if a future engine honours the plain property, the gradient still renders correctly. `field-sizing: content` on `textarea` is progressive — engines without it fall back to `min-height` plus `rows`.

## Alternatives considered

Keeping the styling gated on `.field` and only documenting the wrapper harder: rejected, because the failure is silent and lands in published reports rather than in review. Styling only `textarea` and leaving the rest: rejected, the same gap existed for every other control type.
