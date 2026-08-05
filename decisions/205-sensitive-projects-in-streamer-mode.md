# 205 — Sensitive projects: masked, locked and silent, but only in streamer mode

## Context

Streamer mode (decision 161) blurs identity-bearing *values*. It does not help with a whole project that must never appear on camera: its name shows in the dashboard, pickers and breadcrumb, its task titles surface on cross-project surfaces, and its notifications keep firing during a recording. A single mis-click into it leaks everything.

## Decision

`Project.sensitive` (Project Settings → **Board** tab, new Privacy section) marks such a project. The flag is **inert on its own** — every effect is gated on streamer mode being on, and then:

- **Masked** — the project name and its task text carry `streamer-private` on every surface outside the project: `ActivityOverview` rows, the `GlobalHeader` project dropdown, `ProjectQuickSwitchModal` (new `getTextClassName` prop on `PaletteShell`), `TaskSwitcherOverlay` (title, overview, and the terminal thumbnail via `streamer-private-media`), `MoveToProjectPicker`, `TmuxSessionManager`.
- **Locked** — the one `navigate()` choke point in `App.tsx` refuses any route into it (info toast), checked *before* the dirty-form guard so a refused route never prompts to save; turning streamer mode on while inside it redirects to the dashboard. The dashboard row stays visible with a lock glyph, `aria-disabled` and `cursor-not-allowed` — a project that silently vanished would read as data loss.
- **Silent** — `deliverTaskNotification`, `pushCliToast`, `pushCliAttention`, `pushCliShowImage`, `pushCliShowArtifact` **drop** (never queue) events for it, so nothing resurfaces once the mode goes off. The renderer reports `{streamerMode, sensitiveProjectIds}` through the new `setStreamerPrivacy` RPC, because streamer mode is per-client `localStorage` state and the backend has no other way to know.

Two deliberate deviations from "mask, don't replace":
- `document.title` cannot be blurred (CSS reaches the document, not the browser chrome), so the title prefix is **replaced** with a neutral placeholder.
- A native `<select>` option cannot carry the blur class, so `CreateTaskModal` **filters** locked projects out of its project picker instead of masking them.

`TerminalFocusAttentionPayload` gained `projectId` solely so the attention badge can be gated at the same choke point.

## Risks

- **No client reports ⇒ nothing is silenced.** In headless `dev3 remote` with no browser attached, the backend's flag stays false. Accepted: with no client there is no screen to leak on.
- **Last writer wins.** One flag is shared by all clients, so a remote browser with `?streamer=on` (every agent QA run) silences the desktop's notifications *for sensitive projects only*. Accepted.
- **The bare terminal bell is not gated** — `pushTerminalBell` only knows a session key, and resolving its project would mean a full task scan on every bell. The badge carries no content, and its card is unreachable + masked.
- Blur remains CSS-only: values stay in the DOM and the accessibility tree, exactly as in decision 161. The routing block, not the blur, is what prevents the leak.

## Alternatives considered

- **Hide sensitive projects entirely** while recording — maximal protection, but a vanished project reads as data loss and hides that the guard is working.
- **Effects always on, not just in streamer mode** — turns the flag into a permanent lock; the user wants the project usable off camera.
- **Guard each of the ~10 entry points** (card, Cmd+1..9, Cmd+K, palette, deep link, notification click…) — every future entry point would silently bypass it.
- **Unlock-for-this-session** button — the escape hatch already exists: turn streamer mode off.
