# UX Principal Report: Voice Dictation (NerdDictum integration)

Date: 2026-06-10 (updated 2026-07-05: delivery modes, key gating, rebase on current surfaces)
Mode: planning only
Manifest status: current (updated with this feature)
Confidence: high (placement), medium (Electrobun mic-permission risk)

**Provider note:** the transcription backend is the **Google Gemini API called directly**
(`generativelanguage.googleapis.com`, key from Google AI Studio) — not OpenRouter. This is a 1:1
port of NerdDictum's `gemini.ts`.

## 1. Feature understanding

- **User job:** Dictate text by voice into any text field and into task terminals (prompting AI agents by voice), with AI cleanup of technical jargon. Source: NerdDictum (`~/Desktop/src-shared/tech-voice-recognition-tool`) — Electron floating widget, ported 1:1 at the library level, minus the floating window.
- **Owning object or workflow:** Cross-cutting input augmentation. Configuration owned by Global Settings.
- **Feature class:** expert input shortcut (constant frequency) + configuration + onboarding.
- **Scope:** global (every editable field + every terminal, all screens).
- **Frequency:** constant (primary author uses it for most text entry).
- **Risk:** mostly safe (text lands where focus was; default "Send" mode submits terminal prompts — the alternate "Insert only" stop is always one gesture away); privacy-sensitive (audio sent to Google Gemini; API key stored locally).
- **Discoverability need:** medium — one always-visible header control + tips; power use is the hotkey.
- **Assumptions:** Gemini API key comes from Global Settings or `GEMINI_API_KEY` env var (settings wins). Feature is fully optional; app works untouched without a key.

## 2. UX placement decision

### Core model: **global focus-follow dictation** (not per-input mics)

One recording pipeline, three entry points, one insertion rule:

- **Entry points:**
  1. Global hotkey `Cmd/Ctrl+Shift+M` — toggle record/stop. Registered in the existing `useGlobalShortcut` capture-phase handler (`App.tsx`), so it works while a terminal has focus.
  2. Header mic button — ghost icon button in `GlobalHeader`, placed next to `PreventSleepToggle` (precedent: app-level utility toggles live there).
  3. (Phase 2, optional) tiny mic adornment inside the 2 heavyweight textareas only (CreateTaskModal description, task notes editor). Not in phase 1.
- **Insertion rule (focus-follow):** the *dictation target* is captured at record-start, not at transcription-end:
  - focused `input`/`textarea`/contentEditable → insert at cursor on completion;
  - focused terminal (ghostty-web) → deliver via the existing terminal handle exactly like `TerminalComposer.deliver()`: `handle.paste(text)` (mode-2004-aware bracketed paste) + optional `handle.sendInput("\r")`;
  - nothing focused → copy to clipboard + success toast "Copied to clipboard".
  - The target element is remembered so the user can click elsewhere while transcription runs; text still lands where recording started (matches the requested terminal flow: press, speak, it pastes when recognition finishes).
- **Delivery modes — "Send" vs "Insert only":** two modes, **Send is the default**:
  - **Send (default):** transcript is delivered *and submitted* in one shot — terminal gets paste + `\r`; a single-line `input` gets an inserted value + a synthesized `Enter` keydown (so Enter-submitting fields fire); multiline `textarea`/contentEditable gets insert only (Enter means newline there — auto-submit would corrupt text; documented limitation).
  - **Insert only:** transcript is inserted/pasted, nothing is submitted.
  - Default mode is a setting (`voice.deliveryMode: "send" | "insert"`, default `"send"`). Per-recording override at stop time: the pill's secondary stop button (and `Shift+Enter` / `Shift+hotkey`) stops using the *non-default* mode, so both are always one gesture away without opening settings.
- **Recording state UI:** a single **dictation pill** — fixed overlay, bottom-center, above all content (same layer family as toasts). Shows: pulsing mic + live audio-level ring (port of `AudioLevelRing`), elapsed timer, target hint ("→ terminal: task #715" / "→ Description" / "→ clipboard"), Stop and Cancel. States: recording → transcribing (spinner) → auto-dismiss on success / inline error with retry.

### Rejected placements

- **Mic icon inside every input (the literal "microphones everywhere" ask):** rejected. Dozens of inputs (CreateTaskModal, notes, settings, rename fields, label editor…), pure button creep (project anti-pattern #1), doesn't solve the terminal at all — so the global mechanism must exist anyway, making per-input mics redundant chrome. Phase 2 may add it to the 2 big textareas only.
- **NerdDictum-style always-floating widget:** rejected — duplicates the header button, steals space in a terminal-centric app, and the whole point of the merge is to drop the separate window.
- **Task info panel bar:** rejected — dictation is not a task-scoped action; it's an app-level input utility.
- **Native menu only:** rejected as the *primary* entry (fine as a mirror later) — invisible, and unavailable in browser remote mode.

### Visibility rule / feature gating

**The feature is hard-gated on a Google Gemini API key** (Global Settings key, falling back to the
`GEMINI_API_KEY` env var). Without a key nothing records and nothing is sent anywhere. The header
mic stays visible in the unconfigured state, but clicking it (or pressing the hotkey) opens the
**setup modal** instead of recording — that *is* the discovery/onboarding path. Once a key is
saved, the same entry points start recording immediately, no restart.

## 3. Navigation and menu changes

- Add: nothing to global nav (this is not a destination).
- Add: `global_header.allowed` gains `voice_dictation_toggle` (manifest updated).
- No change: breadcrumbs, sidebar, board.

## 4. Action hierarchy and token decisions

| Element | Label | Semantic role | Token classes | Visibility | Notes |
|---|---|---|---|---|---|
| Header mic button | `t("voice.start")` / `t("voice.stop")` tooltip | ghost (icon) | transparent + `hover:bg-raised-hover`, recording: `text-danger` pulse, transcribing: `text-accent` | persistent | Nerd Font mic glyph (`\u{F036C}` mic / `\u{F036D}` mic-off family); use the `Tooltip` primitive |
| Pill: Stop (default mode) | `t("voice.stopSend")` / `t("voice.stopInsert")` per default | primary | `bg-accent hover:bg-accent-hover` | while recording | Enter or hotkey again; label reflects `voice.deliveryMode` |
| Pill: Stop (alternate mode) | the opposite label | secondary | `bg-elevated border-edge hover:bg-elevated-hover` | while recording | Shift+Enter / Shift+hotkey; one-shot override of the default mode |
| Pill: Cancel | `t("voice.cancel")` | ghost | `text-fg-muted hover:bg-raised-hover` | while recording/transcribing | Esc also cancels |
| Pill container | — | — | `bg-overlay border-edge` rounded-full shadow | recording/transcribing | level ring uses `--danger` while recording |
| Setup modal CTA | `t("voice.setup.save")` | primary | `bg-accent` | modal footer | disabled until key non-empty |
| Settings "Voice Dictation" section | — | configuration | standard settings section | settings screen | see §5 |

No new tokens needed (`--danger` pulse for recording, `--accent` for transcribing). No hardcoded colors.

## 5. Layout and component plan

- **Screen pattern:** overlay service (like `confirm()`/toast hosts mounted in `App.tsx`) + settings section + modal.
- **Reuse:** Modal pattern from `*Modal.tsx`; toast service for errors/success; `SettingsSection` wrapper; Select component for model/device pickers.
- **New components:**
  - `src/mainview/voice/useVoiceDictation.ts` — controller hook (state machine: idle → recording → transcribing → done/error; target capture; insertion).
  - `src/mainview/voice/VoiceDictationPill.tsx` — the overlay pill (+ ported `AudioLevelRing`).
  - `src/mainview/voice/VoiceSetupModal.tsx` — onboarding (port of NerdDictum `Welcome.tsx` + `ApiKeyHelp.tsx` content, restyled with dev3 tokens, links opened via existing external-URL RPC).
  - `src/mainview/components/global-settings/VoiceSettingsSection.tsx`.
  - Ported libs: `src/mainview/voice/audio.ts`, `wav-encoder.ts`, `sounds.ts` (1:1 from NerdDictum `src/lib/`), worklet → `src/mainview/public/audio-processor.worklet.js`.
  - Bun side: `src/bun/voice/gemini.ts` (1:1 port of `src/lib/gemini.ts`), `src/bun/rpc-handlers/voice.ts`.
- **Not allowed:** native dialogs (banned), a separate window, per-input mics on small fields, stats page / clipboard-history / tray / OS-global hotkey / auto-paste-to-other-apps (NerdDictum features intentionally dropped — dev3 is the only consumer).
- **Progressive disclosure:** settings section shows API key + configured status + delivery-mode default (Send / Insert only) first; "Advanced" collapsible for model, languages, speech domain, custom keywords, mic device, silence detection, sounds.

## 6. Interaction contract

- **Trigger:** `Cmd/Ctrl+Shift+M` or header mic click.
- **Preconditions:** voice configured (key in settings or env). If not → open `VoiceSetupModal`. Mic permission granted — `NotAllowedError` → error toast with hint.
- **Recording:** pill appears bottom-center; level ring animates; timer counts; silence auto-stop (if enabled, default 2.5s) behaves like pressing Stop; max 15 min, min 250ms (errors → toast).
- **Stop:** hotkey again / Enter / pill primary Stop → stop in the **default delivery mode**; Shift+hotkey / Shift+Enter / pill secondary Stop → stop in the **alternate mode** (one-shot). Pill switches to "Transcribing…" spinner; audio (opus webm/ogg) → RPC → bun → Gemini (retry ×2, 30s/120s timeouts — ported logic). Silence auto-stop uses the default mode.
- **Cancel:** Esc / pill Cancel → discard audio, no request; while transcribing → abort request.
- **Success:** transcript delivered per focus-follow rule + chosen delivery mode (Send default: terminal paste + `\r`, single-line input insert + Enter keydown, textarea insert only); optional soft sound (ported `sounds.ts`, off if `soundEnabled=false`); pill dismisses. For clipboard fallback — `toast.success`.
- **Error:** `toast.error` with message; auth errors (401/403) get an extra "Open voice settings" action hint.
- **Target death:** if the captured input unmounted (modal closed) → clipboard fallback + toast "Target closed — copied to clipboard".
- **Concurrency:** one recording at a time; hotkey while transcribing is ignored (pill shows state).
- **Keyboard/focus:** pill is `role="status"` and never steals focus — the user keeps typing/working; Esc/Enter handled at capture phase only while pill is active.
- **Responsive:** pill max-width clamps; compact mode (≤1600px) header button is icon-only (it already is).
- **Browser remote mode:** fully supported — recording happens in the browser (getUserMedia), transcription happens on the host (key never leaves the bun process). Requires secure context (localhost or HTTPS tunnel); plain-HTTP LAN → mic unavailable → explanatory error toast.

## 7. Accessibility requirements

- Header button: `aria-label` + tooltip, `aria-pressed` while recording.
- Pill: `role="status"`, `aria-live="polite"` announcing "Recording…", "Transcribing…", "Inserted".
- All controls reachable by keyboard; Esc cancels.
- Level ring is decorative (`aria-hidden`); state is conveyed by text.
- Recording pulse uses opacity, respects `prefers-reduced-motion`.

## 8. Manifest updates

- `docs/ux/ux-architecture.yaml`: `global_header.allowed` += `voice_dictation_toggle`; new surface `dictation_pill` (overlay; allowed: recording status, stop/cancel; forbidden: navigation, configuration, unrelated actions).
- `docs/ux/UX_DECISIONS.md`: decision "Voice dictation: global focus-follow with a 'Send by default' delivery mode" (2026-07-05).

## 9. Implementation brief for coding agent

Implement exactly this (phase 1):

1. **Port libs 1:1** from NerdDictum: `gemini.ts` (+ tests) → `src/bun/voice/`; `audio.ts`, `wav-encoder.ts`, `sounds.ts` (+ tests) → `src/mainview/voice/`; `audio-processor.worklet.js` → mainview public dir (verify the worklet URL resolves under both Vite dev and `views://` — adapt `getWorkletUrl`). Keep `retainPcmForWav` off (opus path only).
2. **Settings:** extend `GlobalSettings` (`src/shared/types.ts`) with `voice?: { apiKey: string; deliveryMode: "send" | "insert"; model: string; languages: string[]; speechDomain: string; customKeywords: string; microphoneDeviceId: string; silenceDetectionEnabled: boolean; silenceDurationMs: number; soundEnabled: boolean }`. `deliveryMode` defaults to `"send"`. Bun-side effective key = `settings.voice.apiKey || process.env.GEMINI_API_KEY`; **no key ⇒ feature inert** (every entry point routes to the setup modal).
3. **RPC:** `transcribeVoice({ audioBase64, mimeType }) → { transcript }` and `getVoiceStatus() → { configured: boolean; keySource: "settings" | "env" | "none" }` in `src/bun/rpc-handlers/voice.ts`. Never send the key to the renderer for status checks (settings screen edits it via the normal settings RPC).
4. **Controller + pill:** `useVoiceDictation` + `VoiceDictationPill` mounted once in `App.tsx`. Focus-follow targeting incl. a terminal-target registry (TerminalView registers its handle while focused; delivery reuses the `TerminalComposer` mechanics — `handle.paste(text)` + `handle.sendInput("\r")` when sending).
5. **Entry points:** `Cmd/Ctrl+Shift+M` in the `useGlobalShortcut` block (`App.tsx`) — capture phase, so it fires even while a terminal has focus; `Shift` variant stops in the alternate delivery mode. Mic ghost button in `GlobalHeader` next to `PreventSleepToggle`. Register the shortcut in `src/mainview/keymap.ts` and add a "Start voice dictation" command-palette entry.
6. **Onboarding:** `VoiceSetupModal` (React, token-styled; AI Studio steps, personal-Gmail warning, password input) opened when unconfigured; saving the key proceeds without restart.
7. **Settings UI:** `VoiceSettingsSection` in Global Settings with progressive disclosure (key + status first, advanced collapsed).
8. **i18n:** all strings in en/ru/es domain files (new `voice.ts` domain). **Tips:** 2 entries (hotkey; setup).
9. **Tests:** ported lib tests adapted; reducer/hook tests for the state machine; RPC handler tests (no key / bad key / happy path with mocked fetch); component tests for pill + setup modal.

Do not implement:

- Per-input mic buttons (phase 2 decision pending), stats page, transcript/clipboard history, tray, OS-level global hotkey, auto-paste to other apps, hold-to-record, native dialogs of any kind.

**Spike first (risk gate):** verify `navigator.mediaDevices.getUserMedia` works inside Electrobun's WKWebView (desktop mode) — permissions, and that `MediaRecorder` + AudioWorklet are available. If WKWebView blocks mic, fallback design: desktop records via a bun-side `sox`/`ffmpeg`-less route is **not** acceptable for 1:1 port — escalate to the user before building around it.

Likely files to inspect or modify:

- `src/shared/types.ts`, `src/bun/rpc-handlers.ts` (barrel), `src/bun/rpc-handlers/voice.ts` (new), `src/bun/voice/gemini.ts` (new)
- `src/mainview/App.tsx`, `src/mainview/components/GlobalHeader.tsx`, `src/mainview/TerminalView.tsx`
- `src/mainview/voice/*` (new), `src/mainview/components/global-settings/VoiceSettingsSection.tsx` (new)
- `src/mainview/i18n/translations/{en,ru,es}/voice.ts` (new), `tips.ts`

Acceptance criteria:

- With no key: mic click / hotkey opens setup modal — recording never starts, nothing is sent anywhere; after pasting a key, dictation works immediately.
- With `GEMINI_API_KEY` env var and empty settings: status = configured (env), dictation works.
- Default mode (Send): dictating with a terminal focused pastes into that tmux pane **and** sends `\r` (agent receives the prompt in one shot); the hotkey works even while the terminal has focus.
- Alternate stop (Shift+hotkey / Shift+Enter / secondary pill button): pastes without Enter.
- With `voice.deliveryMode = "insert"` the defaults swap (primary stop inserts, alternate sends).
- Dictating into CreateTaskModal description inserts at cursor (textarea — never auto-submits); with nothing focused the transcript lands in the clipboard with a toast.
- Esc cancels at any stage with no insertion. Errors surface as toasts, never native dialogs.
- Works in `dev3 remote` over HTTPS tunnel; over plain HTTP shows the secure-context error toast.
- `bun run lint` + `bun run test` green; strings localized in en/ru/es; 2 tips registered.
