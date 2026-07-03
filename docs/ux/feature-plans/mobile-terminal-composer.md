# UX Principal Report: Mobile terminal composer (touch input model)

Date: 2026-07-02
Mode: planning only
Manifest status: updated (decision appended, `surface_adaptation.terminal_input` added, bible §12.3 row added, stale `primitive_bottom_sheet` status synced)
Confidence: high (3-agent pass: competitive research + adversarial critique + code-constraints audit)

## 0. Problem

On a phone the on-screen keyboard eats ~50% of the screen. Today, tapping the terminal focuses
ghostty's hidden textarea (`TerminalView.tsx` touchstart → `hiddenTextarea.focus()`), summoning the
OSK — leaving ~4 terminal rows between the browser URL bar and the keyboard. Typing a prompt to an
AI agent char-by-char into that slit is the single worst mobile UX in the product.

## 1. Decision — two-mode input model (docked composer default, raw toggle)

**Compose mode (default on touch):** the terminal never focuses the hidden textarea. A **docked
chat-style composer** sits between the terminal surface and `ExtraKeyBar`: an autogrow textarea
(1 → ~4 lines), a primary **Send** button, and an **expand** affordance for long prompts
(full-height editing state). The OSK appears only while the composer is focused; the terminal tail
(≈5–8 rows) stays visible above it — the user reads the agent's question while answering. Send
delivers the text via a **mode-2004-aware paste** (bracketed paste only if the foreground app
enabled DECSET 2004 — ghostty-web's `paste()` semantics / the existing server-side WS paste path)
followed by `\r`. A secondary **Insert** (paste without Enter) lives behind long-press/overflow.

**Raw mode (sticky toggle):** a `⌨` key on `ExtraKeyBar` (accent-active state, like the sticky
Ctrl) restores today's behavior — tap focuses the hidden textarea, direct char-by-char typing,
touch→mouse forwarding (select-to-copy, TUI mouse). For `less` search, passwords, single-key
`y/n` TUIs. Sticky per pane-session, visibly toggled.

`ExtraKeyBar` continues to serve Esc/Ctrl/Tab/Enter/arrows **without** the OSK in both modes —
Claude Code permission prompts (arrows + Enter) cost 2 taps and never need the keyboard or the
composer.

This is the converged industry pattern: Termius (AI widget "Paste mode" — compose-then-paste +
dictation), Blink Shell (Snips/Scratch compose surface over raw input), Happy and Omnara (chat-bar
clients for Claude Code). Nobody hides the terminal while composing; nobody dropped raw input
entirely.

## 2. Rejected shapes

- **Fullscreen compose popup as the default** (the original idea): hides the very output the user
  is answering; every competitor keeps the terminal tail visible. Kept only as the expand state.
- **Unconditional `\x1b[200~…\x1b[201~` wrapping:** bracketed paste is an app-enabled mode; a plain
  shell `read`/password prompt would receive literal `[200~` garbage. Paste must be mode-aware.
- **Raw-input-only + chrome collapse** (JuiceSSH pattern): the legacy model everyone is migrating
  away from for agent prompting; typing prompts into 4 rows stays miserable.
- **Shrinking the OSK / app zoom as the fix:** the web cannot size the OSK at all; terminal
  `zoomLevel` exists and may default smaller on touch, but it is not load-bearing.

## 3. Placement & gating

- **Gate = `!isElectrobun && isTouchDevice`** (the ExtraKeyBar gate, `TaskTerminal.tsx:327`) — this
  is an *input-model* switch, not a layout switch, so it does **not** gate on `useNarrowViewport`
  (a wide Android tablet has the same OSK problem). Doctrine's breakpoint ladder is untouched.
- **Hosts:** all terminal surfaces — `TaskTerminal` *and* `ProjectTerminal` (Quick Shell), which
  today lacks even `ExtraKeyBar` (a standing touch-unreachability gap; fix in the same work).
- Composer is a flex-flow sibling (terminal → composer → ExtraKeyBar), **not** `position:fixed` —
  Android Chrome's `interactive-widget=resizes-content` (already set in `useViewport.ts`) shrinks
  the layout and the bar lands above the OSK for free. iOS Safari ignores that meta (WebKit
  #259770): the `visualViewport` pinning shim is an additive follow-up, not a blocker (Android
  first, honestly).
- While the composer is focused, collapse non-essential chrome (global header, window/pane bars)
  keyed off **composer focus state** — a React state we own — not off visualViewport sniffing.

## 4. Focus discipline (the bug farm — must-fix list)

1. `TerminalView.tsx` blur→refocus guard (~:401–410): on composer close, focus lands on `body` and
   the hidden textarea re-grabs focus → OSK re-summons. Gate the guard off in compose mode.
2. `TerminalView.tsx` touchstart→`hiddenTextarea.focus()` (~:491–498): disable in compose mode.
3. `ExtraKeyBar.tsx` `handle.focus()` after every key (:27,34,39): must refocus the **composer**
   when it is open/focused, the terminal otherwise — else Esc/arrows steal focus and retarget the OSK.

## 5. Explicit semantics decisions

- **Tap on terminal in compose mode:** no canvas mousedown forwarding → drag-select-to-copy and TUI
  mouse clicks are **raw-mode-only on touch**. This supersedes the select-to-copy affordance on
  touch (`terminal-select-to-copy-affordance.md`) — update its tip copy with the raw-mode caveat.
- **Send** = paste (mode-aware) + `\r`; **Insert** = paste only. One primary button; no button pair.
- Composer is *the* primary action of the terminal screen while focused (budget: 1 primary — Send,
  semantic role `primary`, accent token). `⌨` raw toggle: `icon` role on ExtraKeyBar, accent-active
  when on. All targets ≥44px physical.

## 6. Complements (separate small PRs, not load-bearing)

- **PWA manifest** (standalone display): removes the browser URL bar (~56px) once installed.
- **Smaller default terminal zoom on touch** via the existing `zoomLevel` mechanism (optional).
- Optional later: mic/dictation button on the composer (OSK dictation already works today);
  digits/`y n` micro-group on ExtraKeyBar if raw-mode round-trips prove annoying.

## 7. Acceptance

- Touch + browser mode: tapping the terminal never summons the OSK; composer focus does.
- Terminal tail visible while typing (Android Chrome ≥5 rows at 390×844 with OSK open).
- Send delivers multiline text to Claude Code as one paste + Enter; Insert leaves it uncommitted;
  plain `read` prompt receives clean text (no `[200~`).
- Raw toggle restores today's typing + selection; sticky; visibly active; Esc/arrows/Enter on
  ExtraKeyBar never steal focus from an open composer.
- Quick Shell has ExtraKeyBar + composer parity with the task terminal.
- Desktop (Electrobun) behavior byte-identical.

## 8. Likely files

`TerminalView.tsx` (focus gating, handle API), new `components/TerminalComposer.tsx`,
`TaskTerminal.tsx` + `ProjectTerminal.tsx` (mount), `ExtraKeyBar.tsx` (raw toggle, focus
discipline), `hooks/` (shared compose-mode state), `bun/rpc-handlers/tmux-pty.ts` (paste path if
server-side), i18n `terminal.ts` domain (en/ru/es), `tips.ts` (composer tip, score 4; select-to-copy
tip caveat), tests for composer + focus discipline.

## Evidence

- Competitive research (2026-07-02): Termius mobile-terminal docs + AI-agents blog; Blink Shell
  docs/CHANGELOG (Snips); happy.engineering docs; omnara.com; JuiceSSH FAQ; WebKit bug 259770;
  htmhell.dev interactive-widget writeup.
- Code audit: `TerminalView.tsx` input paths (beforeinput/input/compositionend → WS), hidden
  textarea focus/blur guards, `TerminalHandle` = `{sendInput, focus}`; ghostty-web `paste()` is
  DEC-2004-aware (`vendor-docs/ghostty-web/api/terminal.md`); `BottomSheet.tsx` exists (safe-area,
  focus trap, swipe-down); app root `100dvh`; `ProjectTerminal.tsx` has no ExtraKeyBar.
- Adversarial critique: fullscreen-default context loss (HIGH), unconditional bracketed paste
  (HIGH), the three focus traps (HIGH), tap-semantics/select-to-copy conflict (MED), permission
  prompts already OSK-free via ExtraKeyBar (MED), composer-focus-keyed chrome collapse (MED),
  touch-not-width gating + host coverage (LOW), Android-first honesty (LOW).
