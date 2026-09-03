# Bundle the unpatched face, and name every Nerd Font honestly

## Context

Issue #1625 reported that the picker's "JetBrains Mono" looks and renders differently from
JetBrains Mono in Ghostty, concluded the bundled face has different metrics, and asked for a
separately selectable system font. Two of those three things are real; the metrics claim is
not, and the distinction matters because it points at a different subsystem.

## Investigation

**The two faces are metrically identical.** Read straight out of the shipped
`JetBrainsMonoNerdFontMono-Regular.woff2` and upstream `JetBrainsMono-Regular.ttf` with
fontTools: `unitsPerEm` 1000, advance of `M` 600, hhea ascent 1020, descent −300, lineGap 0,
cap height 730, x-height 550 — every number the same. A Nerd Font patch adds glyphs; it does
not move the ones that were there.

**The width difference is ours, and it is not about the font.** ghostty-web derives its cell
from `Math.ceil(measureText("M").width)` in CSS pixels (`measureFont`, `dist/ghostty-web.js`).
At 16 px JetBrains Mono advances 9.6 px, so the cell becomes 10 — every column 4.2 % wide.
Measured on the reporter's own screenshot: dev3 19.93 device px per column against Ghostty's
18.99, one device pixel, matching the prediction. Native Ghostty rounds in device pixels and
does not pay that.

**Availability detection is not producing a false negative, at least in Chromium.** Probed
against fonts genuinely installed on this machine but not bundled (`JetBrainsMono Nerd Font`,
`JetBrainsMonoNL Nerd Font Mono`, `Menlo`, `Monaco`): all reported available; uninstalled
names reported missing. The reporter's failure was not reproduced — they are on WKWebView,
which was not tested, so this stays open rather than answered.

**Why the installed font could not be selected** is a plain bug, and not in the probe.
`Select`'s `typedIsNew` (`src/mainview/components/Select.tsx`) suppresses the "use what you
typed" row when the text matches any option's **label**, case-insensitively. The label was
literally "JetBrains Mono", so typing it selected the patched face and there was no way to
reach anything else by that name.

## Decision

**Every label names the face it actually is** (`BUNDLED_TERMINAL_FONTS`,
`src/mainview/terminal-font.ts`): the fifteen patched faces became "… Nerd Font", and
unpatched JetBrains Mono ships beside them as its own 16th option (90 KB, family
`'JetBrains Mono'`, declared in `index.css`). Renaming the labels also fixes the picker
without touching `Select`: "Hack Nerd Font" no longer swallows a typed "Hack", so a locally
installed font is reachable again for every family, not just this one. The shared component
keeps its current behaviour, which the rest of the app relies on.

The chosen family still leads a stack ending in the reference Nerd Font, so an icon glyph the
plain face lacks falls through instead of rendering as a box — what the issue asked for, and
it needed no new code. Verified by rendering to a canvas and counting lit pixels in the
running app: `U+E709` and `U+F07B` come out pixel-identical to the Nerd Font and unlike the
plain face's `.notdef`.

Worth knowing while reading that: **upstream JetBrains Mono carries the basic powerline
glyphs itself** (`U+E0A0`, `U+E0B0`, `U+E0B2` are in its cmap — 1363 mapped codepoints
against the patched face's 11756). Those render from the plain face in its own slightly
different shape and never reach the fallback, so a prompt does not go blank on the plain
option; only devicons and the wider icon sets fall through. Testing the fallback on `U+E0A0`
proves nothing, which is how it first looked broken here.

**The default is unchanged.** An empty stored value still resolves to the Nerd Font variant.
Switching it would silently strip powerline and devicon glyphs out of every existing user's
prompt, which is a worse bug than the one being fixed.

**ghostty-web's cell rounding is left alone,** deliberately and on the user's call. It is
vendor code, the fix belongs upstream, and compensating from outside would mean rendering a
size the user did not pick.

`src/bun/__tests__/bundled-terminal-fonts.test.ts` guards what the list could not before: a
family with no `@font-face`, a `@font-face` pointing at a missing file, a duplicate label or
family, and a label that names another entry's family. Proven against two mutants — a typo'd
family name, and the old colliding "JetBrains Mono" label.

## Risks

- **A bundled family gets no availability warning by design.** `isTerminalFontAvailable`
  short-circuits to `true` for anything in the list, so a typo'd family would render the
  fallback at that entry's `scale` — wrong font *and* wrong size, silently. That is exactly
  what the new guard exists to catch; the reasoning is only sound while it passes.
- **`'JetBrains Mono'` now shadows a system font of the same name.** Someone with upstream
  JetBrains Mono installed gets ours instead. Same typeface, possibly a different version;
  worth knowing before anyone debugs a glyph difference.
- The reporter's availability false negative is unexplained on WKWebView. It no longer blocks
  them — the font is a list option now — but the underlying question is unanswered.

## Alternatives considered

- **Relax `Select`'s label collision instead of renaming labels.** Rejected as the primary
  fix: it changes a component every other picker uses, and it would leave the labels lying.
  Honest labels solve the same problem locally. Worth doing separately if a label collision
  ever appears where renaming is not an option.
- **Make unpatched JetBrains Mono the default.** Rejected — see above, it breaks existing
  prompts.
- **Ship no font and rely on the installed one.** Rejected: it makes the option's appearance
  depend on the machine, which is what bundling was for.
- **Compensate for the cell rounding by shrinking the requested size.** Rejected: it renders
  a size the user did not choose, and cannot land on a half pixel anyway.
