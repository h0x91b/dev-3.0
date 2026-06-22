# 077 — Clear stale terminal selection on alt-screen writes

## Context
Double-clicking a word in the terminal selects it, but the blue highlight stayed
glued to the same screen cells while a full-screen TUI (Claude Code, vim, htop)
repainted under it — a stale highlight floating over the wrong characters.

## Investigation
Verified in the built `ghostty-web` 0.4.0 (`node_modules/ghostty-web/dist/ghostty-web.js`):
the selection is stored by absolute buffer row and `normalizeSelection()` converts
absolute↔viewport correctly, so on the **primary** screen the highlight scrolls away
with its text. But the `write()` path never touches the selection — `clearSelection()`
is only called on new mousedown, click-outside, resize, and dispose. On the
**alternate** screen there is no scrollback (`viewportY` stays 0), so the selection's
absolute row maps to the same screen cells forever while the TUI rewrites them in
place. xterm.js clears/trims selection on changed lines; ghostty-web does not.

## Decision
Added `clearStaleSelectionOnWrite(term)` in `src/mainview/TerminalView.tsx`, called
right after the batched `batchTerm.write()` in `enqueueTermWrite`. It clears the
selection only when `term.isAlternateScreen() && term.hasSelection()`. Primary-screen
scrollback selections are deliberately left untouched.

## Risks
On the alternate screen the selection is dropped on the next program output, so
select-to-copy during active streaming is harder. Acceptable: copy normally happens
while idle (no writes), and a stale wrong highlight is worse. Mouseup already copies
via the native selection bridge at gesture end.

## Alternatives considered
- Clear only when dirty rows intersect the selection — more precise but needs wasm
  dirty-row access and more code; Claude's TUI repaints the whole screen anyway.
- Patch/upgrade ghostty-web upstream — it's an external `^0.4.0` dep; patching
  `node_modules` is not durable.
- Clear on any scroll/wheel — only addresses scrollback, not the alt-screen case.
