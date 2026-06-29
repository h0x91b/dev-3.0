# UX Principal Report: Alt/Option-click to move terminal cursor

Date: 2026-06-29
Mode: planning only
Manifest status: updated (UX_DECISIONS + changelog appended)
Confidence: high

## 1. Feature understanding

- User job: reposition the shell/readline cursor on a prompt line by pointing instead of holding an arrow key.
- Owning object/workflow: the live terminal (`task` full terminal + `project-terminal` / Quick-shell), `TerminalView.tsx`.
- Feature class: **expert_shortcut** — a power-user gesture layered on an existing surface; no chrome, no nav, no toolbar.
- Scope: single object (the focused terminal's active pane / prompt line).
- Frequency: occasional (mid-edit convenience).
- Risk: safe + reversible (emits ordinary arrow keys; readline ignores over-moves past line bounds).
- Discoverability need: medium — invisible gesture, surfaced via a "Did you know?" tip; the keyboard equivalent (arrow keys) already exists, so the gesture is never the only way.
- Assumptions: `hasMouseTracking() === false` reliably identifies a plain shell pane (same signal shipped in the copy bridge + decision 077). Claude Code/vim/htop keep mouse-tracking on → gesture is gated off there.

## 2. UX placement decision

- Route/screen: `task` (full terminal) and `project-terminal` (Quick-shell) — wherever `TerminalView` renders.
- Surface: the terminal canvas itself (gesture, not a control).
- Menu/nav group: none.
- Entry point: `Alt`/`Option` + primary (left) mouse-down on a cell.
- Visibility rule: active only when `!term.hasMouseTracking()` (plain shell) **and** the clicked cell is on the cursor's row.

Rejected placements:
- No toolbar/inspector button, no menu item, no command-palette entry — it is a pointer gesture, not an invokable action. Adding chrome would be exactly the button-creep anti-pattern the manifest guards against.
- No new setting/toggle — the gesture is harmless and self-gating; a preference would be unjustified config.

Rationale: matches the established terminal-gesture precedent (native selection → copy bridge, axis-arbitrated swipe). Gestures live on the surface; discoverability is handled by tips, not chrome.

Evidence: `src/mainview/TerminalView.tsx` (`setupMouseTracking`, `cellCoords`, copy bridge), `decisions/077-clear-stale-altscreen-selection.md`.

## 3. Navigation and menu changes

No change. No add/rename/move/remove.

## 4. Action hierarchy and token decisions

No visible elements, no tokens. (Pure gesture — no buttons, labels, or colors.)

## 5. Layout and component plan

- Screen pattern: existing terminal surface; no layout change.
- Components to reuse: `TerminalView.setupMouseTracking` `onMouseDown`, `cellCoords`, `wsRef` send path.
- New components allowed: none.
- Components not allowed: any new chrome (button/menu/modal/toggle).
- Progressive disclosure: a single "Did you know?" tip.

## 6. Interaction contract

> Revised 2026-07-02: renderer-only gating on `!hasMouseTracking()` proved impossible —
> dev3's tmux runs `mouse on`, which keeps outer mouse tracking permanently enabled
> (decision 093). The shell-vs-TUI decision moved to the backend.

- Trigger: `mousedown` with `e.altKey` and `e.button === 0` on the terminal surface (capture on the canvas parent).
- Normal case — tracking ON (tmux): the renderer forwards the clicked cell to the `tmuxAltClickMoveCursor` RPC and does **not** swallow the event (the SGR bridge, now Alt-bit-aware, still delivers the M-click to mouse-owning apps). The backend hit-tests the pane (`list-panes` geometry, zoom-aware), requires a live shell (`zsh/bash/fish/…`) not in copy-mode, requires the click on the cursor's row, clamps the target to the row's text length, focuses the pane, then `send-keys Left/Right × N`.
- Fallback — tracking OFF (bare PTY, no tmux): renderer-local move via `buildCursorMoveSequence` plain CSI arrows over the WS; the click is swallowed so it never starts a selection.
- Cross-row click: no-op (vertical = shell history, not cursor motion; also avoids driving a stacked pane).
- Claude Code / vim / htop pane: backend no-ops (`pane_current_command` not a shell); the alt-click reaches the app as a real M-click — Claude Code's built-in alt-click works.
- No-modifier click: unchanged (text selection + native copy bridge intact).
- tmux `Alt+Arrow` pane switch: unaffected — arrows are sent via `send-keys`, not as Alt+Arrow.
- Accessibility: keyboard arrow keys remain the primary equivalent (gesture is additive, never sole path); `prefers-reduced-motion` N/A (no animation).
- States: no loading/empty/error/permission states; best-effort, wrapped/multi-line lines documented as out of scope for v1.

## 7. Implementation brief

1. Pure, exported `buildCursorMoveSequence(fromCol, fromRow, toCol, toRow): string` in `TerminalView.tsx` — the bare-PTY fallback (`""` for cross-row / zero delta, else repeated `\x1b[C`/`\x1b[D`). Unit-tested.
2. Pure backend module `src/bun/tmux-alt-click.ts` — `parseAltClickPanes`, `findAltClickPane` (zoom-aware hit-test), `altClickIneligibleReason` (shell allowlist, copy-mode, dead), `computeAltClickKeys` (same-row, EOL clamp, width cap). Unit-tested.
3. Handler `tmuxAltClickMoveCursor` in `rpc-handlers/tmux-pty.ts` (+ `shared/types.ts` schema): list-panes → hit-test → capture-pane row → select-pane (skip when active — unzoom gotcha) → send-keys.
4. Renderer `onAltClickMove`: tracking ON → fire-and-forget RPC, no swallow; tracking OFF → local arrows + swallow. `sgrMouse` call sites add the Alt bit (8).
5. One "Did you know?" tip (`tips.ts` + en/ru/es).
6. Decision record 093 + changelog entry. No `keymap.ts` change (mouse gesture, not an app shortcut).

## What NOT to implement

- No buttons, menu items, command-palette entries, settings, or toggles.
- No vertical cursor movement (shell maps Up/Down to history).
- No SGR-modifier encoding changes for mouse-tracking apps (out of scope).
- No multi-line / wrapped-line cursor solving in v1.

Likely files to change: `src/mainview/TerminalView.tsx`, `src/mainview/tips.ts`, `src/mainview/i18n/translations/{en,ru,es}/tips.ts`, a `decisions/NNN-*.md`, a `change-logs/...` entry, plus a unit test.
