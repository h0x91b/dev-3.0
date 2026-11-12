# dev3 iOS App — Design Plan

Status: **approved plan, not yet implemented.** Companion doc: [IMPLEMENTATION.md](IMPLEMENTATION.md) (phases, tickets, sequencing for the agent fleet).

## 1. Goal

A native iOS app that is a first-class remote client for a dev3 instance running on the user's Mac — the same role the mobile web view (`dev3 remote` in a phone browser) plays today, but solving the three problems the web view cannot:

1. **Navigation is not smooth** — browser chrome, no hardware-back conventions on iPhone, in-page history hacks, portrait-only gate, no fullscreen (iPhone Safari has no Fullscreen API — decision 134).
2. **Zoom is not great** — pinch-zoom is disabled app-wide; the terminal relies on a fixed `0.67` dense-zoom multiplier (decision 107) and hard-to-reach zoom controls.
3. **Typing is not ideal** — the on-screen-keyboard model is a tower of workarounds fighting ghostty-web's canvas (capture-phase focus suppression, `inputmode="none"`, hidden-textarea IME diffing, synthesized mouse events).

**Design rule (from the task brief): follow the mobile web experience** — its information architecture, gestures, and the narrow-viewport doctrine in `docs/ux/PRODUCT_UX_BIBLE.md` §12 — **except where it conflicts with native iOS conventions or where native capabilities solve the three problems above.**

## 2. Why native wins (grounded in the codebase)

| Web-view pain | Root cause | Native answer |
|---|---|---|
| Browser chrome eats screen | iPhone Safari has no element Fullscreen API (decision 134) | The app *is* fullscreen; no chrome to fight |
| Installed PWA was rejected | Tunnel origin unstable per launch (decisions 133/134) | Native app stores the session token itself; origin is just data |
| Sockets die on screen-off | Mobile browsers freeze JS/WS (decision 126) | `URLSession` + scene lifecycle; deterministic reconnect on foreground |
| Typing hacks | ghostty-web canvas owns focus/IME | Native terminal view + native keyboard/IME, keyboard accessory bar |
| No pinch zoom | Viewport meta must lock scale to keep layout sane | Native pinch gesture → terminal font size, per-screen |
| Landscape blocked | Desktop hit-target geometry above 768px (decision 135) | Proper adaptive layouts; landscape supported |
| Notifications only while page open | No service worker/APNs (decision 084) | v1: reliable local notifications while connected; APNs is a designed-for future (§10) |

## 3. Architecture

**A fully native SwiftUI client speaking the existing remote protocol unchanged.** No embedded webview for core surfaces (one exception: sandboxed `WKWebView` for HTML artifacts). The backend already supports this by design:

- Auth: `POST /auth/exchange` (one-time QR JWT or dev static code) → `dev3_session` cookie (24h rolling JWT, refresh via `POST /auth/refresh` every 15 min). Non-browser clients without an `Origin` header are explicitly allowed (`checkOrigin`, decision 133).
- API: JSON-over-WebSocket at `/rpc` — `{type:"request",id,method,params}` / `{type:"response",id,success,payload|error}` / `{type:"message",id,payload}` (push). 120s timeout, queue-while-connecting. Full method surface: `AppRPCSchema` in `src/shared/types.ts:2336-3197`.
- Terminal: per-session WebSocket at `/pty?session=<taskId|project-<projectId>>` carrying a **fully rendered VT/xterm byte stream** from one shared tmux attach client (NOT tmux control mode). Input = raw bytes; resize = `\x1b]resize;<cols>;<rows>\x07`; close codes 4000–4003; OSC 52 clipboard arrives out-of-band as the `osc52Clipboard` push on `/rpc`.
- No push replay on reconnect: client refetches (`getProjects`, `getAllProjectTasks`) after every reconnect.

```
┌─ iPhone ────────────────────────────┐        ┌─ Mac (dev3 desktop or headless) ─┐
│  SwiftUI app                        │        │  remote-access-server.ts          │
│  ├─ Dev3Kit (SessionClient ── auth ─┼─HTTPS──┼─ /auth/exchange /auth/refresh     │
│  │           RPCClient ─────────────┼──WS────┼─ /rpc ── handlers (shared w/ desktop)
│  │           PTYClient ─────────────┼──WS────┼─ /pty ── proxy ── pty-server (tmux)│
│  ├─ Dev3TerminalKit (SwiftTerm)     │        │  cloudflared quick tunnel OR LAN   │
│  └─ Dev3UI (tokens, components)     │        └───────────────────────────────────┘
└─────────────────────────────────────┘
```

**Terminal emulator: SwiftTerm** (battle-tested VT100/xterm engine used by La Terminal/Secure Shellfish). It consumes the same byte stream ghostty-web does and renders natively — real touch scrolling, selection, IME, hardware-keyboard support. tmux **control mode (`-CC`) was evaluated and rejected**: the backend runs a rendered attach client, not control mode, and `-CC` would require shell access the remote transport deliberately doesn't expose. Embedding ghostty-web in a webview was rejected as primary because it re-imports every typing weakness. (Full assessment in the terminal research; constraints from `src/bun/pty-server.ts`, decision 060.)

### Repo & tooling decisions

- **Monorepo**: the app lives in `ios/` in this repo. The protocol contract lives in `src/shared/types.ts` and `src/bun/remote-access-server.ts`; keeping the client next to it lets contract tests and the agent fleet keep them in lockstep.
- **XcodeGen** (`ios/project.yml`) — text-based project spec so parallel agents never conflict on `.pbxproj`.
- **Logic in SPM packages** (`Dev3Kit`, `Dev3TerminalKit`, `Dev3UI`), app target thin. Packages are testable with `swift test` on macOS — no simulator needed, so agents can self-verify cheaply.
- **Min iOS 17**, Swift 5.10+, SwiftUI + Observation. Dependencies: SwiftTerm only (keep the tree tiny).
- **Models**: hand-written `Codable` structs for the used API subset, each annotated with its `src/shared/types.ts` source line. Full codegen from TS was rejected — the schema moves fast and the app consumes ~40% of it; contract tests (T0.2) catch drift.

## 4. Connectivity & pairing

**Pairing** = scanning the existing QR (`<origin>/?token=<jwt>`, 30s single-use) from the desktop app's Remote Access modal or `dev3 remote url`. The app extracts origin + token, calls `/auth/exchange`, and stores per server: origin URL, the `dev3_session` cookie value, display name, instance id — in the **Keychain**.

- **Multi-server**: first-class list of paired instances; one active at a time; switcher on the entry screen.
- **Backend location is deliberately opaque to the app** — it pairs with *an origin*, not "a Mac". This is what makes long-lived remote coding environments (Coder and similar) a supported target rather than a redesign: dev3 already runs headless on Linux (`dev3 remote install-service` / systemd), and a Coder workspace exposing the remote server over its stable HTTPS URL is just another server entry — arguably a *better* one, since a stable origin sidesteps the quick-tunnel URL churn entirely (B4 becomes unnecessary for that instance, and Bonjour/B1 is a Mac-on-LAN convenience, not a dependency). Two integration caveats to verify when that work starts: (a) the dev3 endpoints must be reachable directly — an interactive SSO/auth proxy in front of the workspace URL would block a native `URLSession` client, so the exposed port must pass requests through to dev3's own QR/session auth; (b) pairing needs the QR or `dev3 remote url` output from inside the workspace (manual URL+token entry already covers headless setups). A long-lived always-on backend also strengthens the future APNs case (B5).
- **Session persistence**: the session JWT is signed by a persisted secret (`~/.dev3.0/remote-jwt-secret`) and survives desktop restarts; the cookie value is origin-independent, so the app re-attaches it manually (`Cookie:` header) on whatever origin currently works.
- **Session lifetime**: the 24h TTL is *rolling* — every `/auth/refresh` (15-min cadence while connected, plus one on each app foreground) extends it, so a phone that connects at least once a day never re-pairs. The TTL only bites after a >24h gap, and that hurts most exactly in the long-lived-remote case (re-pairing a headless Coder workspace means shelling in for a fresh QR/URL). Backend item **B6** (§9) extends sessions for native clients: Keychain storage is a materially stronger place for a credential than a browser cookie, so a native-identified `/auth/exchange` can issue a much longer rolling TTL (e.g. 30d) or the device/refresh-token pair decision 133 deferred. Browser sessions keep 24h.
- **Origin instability** (quick tunnels change URL per launch): v1 handles it with (a) **LAN/Bonjour discovery** — small backend addition (§9) advertising `_dev3._tcp` + a `GET /instance` identity endpoint, so on home Wi-Fi the app finds the Mac and revalidates its stored session without any QR; (b) falling back to "scan a fresh QR" when neither the stored origin nor LAN discovery reaches the instance. Named (stable-hostname) tunnels are a fast-follow backend option.
- **Reconnect FSM**: port `src/mainview/remote-session.ts` semantics exactly (it is pure and unit-tested): on socket close, probe `/auth/refresh` — 401/403 → session dead → pairing screen; network error → exponential backoff 2s→15s. Kick both `/rpc` and `/pty` sockets on scene-foreground and network-path change (`NWPathMonitor`), the native analog of the `visibilitychange/pageshow/online` triggers from decision 126.
- **ATS**: LAN mode is plain HTTP → ATS exception for local networks (`NSAllowsLocalNetworking`); tunnels are HTTPS and unaffected. Requires the Local Network permission prompt (fine — it's the app's core function).

## 5. Information architecture & navigation

Follow the mobile web IA (Bible §12), expressed natively. `NavigationStack` per tab; no custom history-stack code (the web's `routeHistory` exists only because browsers lack native navigation).

```
Entry (server picker / pairing) ─ when connected ─▶
TabView:
 ├─ Work (default): Active-tasks strip (NEEDS YOU / WAITING tiers) + project boards
 │    Board = one status column per page, horizontal paging (mirrors MobileBoardCarousel,
 │    auto-lands on the attention column) ─▶ Task screen (push)
 ├─ Projects: dashboard list (add/clone deferred to v2; open board, pull main, settings-lite)
 └─ Settings: servers, appearance, terminal prefs, notifications, about
```

- **Task screen** is the centerpiece: full-screen terminal, window pager → pane pager (swipe, mirroring `MobileWindowCarousel`/`MobilePaneCarousel` and reusing the same `tmuxWindowNavigate`/`tmuxPaneNavigate`/`tmuxAction` RPCs with their idempotent keep-zoom semantics from decision 090), docked composer, keyboard accessory bar, and a task **info sheet** (status, priority, labels, notes, git/PR, actions) as a native bottom sheet (`presentationDetents`) — the native form of the Bible's `BottomSheet` doctrine.
- **Native conventions override web where they conflict**: swipe-back edge gesture instead of Android-back sentinel; context menus (long-press) on cards instead of hover; pull-to-refresh; standard `confirmationDialog` for destructive actions (the "no native dialogs" rule is an Electrobun-remote constraint, not an iOS one — but keep copy/danger semantics identical); landscape **supported** with adaptive layouts instead of a portrait gate.
- **Touch reachability rule carries over verbatim** (Bible's #1 anti-pattern): every action reachable without a keyboard; ≤2 inline actions per card, overflow into sheets.

### Screen inventory (v1)

| Screen | Mirrors (web) | Notes |
|---|---|---|
| Pairing / server picker | QR scan + `remote-session` boot | Camera QR scan, Bonjour list, manual URL entry |
| Work tab (strip + board pager) | `ActiveTasksStrip`, `MobileBoardCarousel`, `TaskCard` | Cards: status dot, title, labels, ≤3 variant dots, priority, PR badge |
| Task terminal | `TaskTerminal` + carousels + `TerminalComposer` + `ExtraKeyBar` | See §6 |
| Task info sheet | `TaskInfoPanel` mobile summary + actions sheet | Move status, priority, labels, watch, rename, overview, notes, cancel/delete (confirmed) |
| Diff viewer | `TaskDiffViewer` | v1 read-only (modes: uncommitted/branch/unpushed/recent-N, file list, unified); inline comments + XML review export in v1.1 |
| PR status detail | `TaskPrStatusPopover` | CI rollup, review decision, unresolved threads, merge blockers |
| Create task / launch | `CreateTaskModal` + `LaunchVariantsModal` (basic) | Title/description, agent+config picker, variant count |
| Image lightbox / artifact viewer | `TaskImageViewer` / `TaskArtifactViewer` | Artifacts in sandboxed WKWebView |
| Settings | `GlobalSettings` subset | Theme, terminal font size default, haptics, notification prefs, server management |

**v2+ (explicitly out of v1):** productivity stats, automations, agent-account management, project settings editing, ports/tunnels management, changelog, tips system, conversation search, quick shell, bug-hunter swarm UI, add/clone project.

## 6. Terminal & typing design (the core bet)

- **Rendering**: SwiftTerm view fed by `PTYClient`. Coalesce writes per display-refresh (`CADisplayLink`), mirroring the web's 16ms server batching + rAF flush — agents emit thousands of chunks/sec.
- **Input modes, same two-mode model as web** (it's a good model — keep it):
  - **Compose (default)**: terminal never summons the keyboard. A docked native composer (`TextField`/`TextEditor`, autocorrect/dictation/swipe work) with **Send** and **Insert**. Port `submitPastedText` semantics exactly (decision 132): bracketed-paste-aware; when DEC 2004 isn't active, wait 150ms after paste before the single CR — this protects Codex.
  - **Raw**: toggle on the accessory bar; keyboard types straight into the PTY. SwiftTerm handles key encoding natively (no ghostty shift bug), but replicate dev3's `Shift+Enter → \x1b\r` convention (`shift-key-sequences.ts`).
- **Keyboard accessory bar** (native `inputAccessoryView` equivalent): Esc, sticky Ctrl, Tab, arrows, Enter, `| ~ - / \``, paste, raw-mode toggle — the `ExtraKeyBar` set, attached to the system keyboard so it never overlaps content. Hardware keyboards (iPad/BT): full passthrough incl. Ctrl/Cmd shortcuts.
- **Zoom**: pinch-to-zoom adjusts terminal font size continuously (live refit + resize message), double-tap to reset to preferred size, persisted per server. No dense-zoom factor, no viewport locking.
- **Scrolling & selection**: native touch scrolling through SwiftTerm's buffer; long-press selection with standard iOS handles; copy integrates with OSC 52 pushes (`osc52Clipboard` → `UIPasteboard`, with the standard iOS paste notice).
- **Panes & windows**: swipe-with-axis-arbitration like the web (horizontal = pane switch, vertical = scroll), dots strip, and a pane sheet (split H/V, new window, close pane with last-pane confirm) — all existing RPCs, no backend change.
- **Shared-PTY min-size constraint** (decision 060): the shared PTY sizes to the *smallest* client, so a phone attaching shrinks the desktop terminal. **v1 accepts this (exact parity with mobile web today)** and makes it legible: a banner when this client is the constraining one, plus a "detach" affordance when leaving the screen. A backend **independent-size viewer mode** is specced as fast-follow B3 (§9) — the one protocol limit a native client cannot paper over.
- **Terminal previews** on cards (v1.1): poll `getTerminalPreview`/`capturePane` snapshots, exactly like the web's hover preview but tap-triggered.

## 7. Visual design

Carry the dev3 identity, not iOS-generic chrome — but respect platform idiom where they collide:

- **Tokens**: port the semantic token set from `src/mainview/index.css` (surface ladder base→raised→elevated→overlay, fg hierarchy, accent/danger/success/warning) and `STATUS_COLORS`/`STATUS_COLORS_LIGHT` from `src/shared/types.ts` into a Swift `Theme` (T0.3 keeps them in sync with a checked-in extraction script). Dark (default, deep space-navy) + light; follow system appearance with manual override.
- **Glass morphism** — the brand element — maps naturally to iOS materials (`.ultraThinMaterial` + per-column status-color glow on column headers/cards).
- **Typography**: system font (SF) for UI — native conventions win here; bundle **JetBrainsMono Nerd Font Mono** for terminal, branch names, code, and as the icon glyph source (same glyphs as the web app; SF Symbols only for pure-navigation chrome).
- Touch targets ≥44pt; haptics on status moves/attention events; card/column radii echo the web (`rounded-xl`/`2xl`).

## 8. Live data, notifications, offline

- **Push-driven UI**: subscribe to the load-bearing pushes — `taskUpdated`, `taskRemoved`, `projectUpdated`, `taskPrStatus`, `ptyDied`, `terminalBell`, `cliToast`, `cliAttention`, `webNotification`, `agentCompletionRequested`, `qrTokenConsumed` — dispatch into an observable store; refetch on every reconnect (no replay exists).
- **Context signals**: send `setActiveContext`, `setWindowForeground` (scene phase), `setTerminalFocus`, periodic `ping` — the backend tunes git-poll cadence off these.
- **Notifications v1**: local notifications (`UNUserNotificationCenter`) from `webNotification`/`cliAttention` while the app runs; app badge = NEEDS-YOU count; in-app toast layer mirrors `toast.tsx` semantics. Honest limitation: nothing arrives while the app is suspended (same as web today).
- **Offline/disconnected**: cached last board state rendered dimmed with a reconnect banner; composer drafts persist locally per task.

## 9. Backend changes required (all small, all graceful-degrade)

The protocol needs **zero changes** for a functional v1. These make it excellent:

| ID | Change | Size | Why |
|---|---|---|---|
| B1 | `GET /instance` (instance id, name, app version, protocol version) + Bonjour `_dev3._tcp` advertisement, feature-gated | S | LAN re-discovery after tunnel URL churn; multi-server identity; version gating |
| B2 | Protocol contract tests in this repo (vitest e2e freezing `/auth`, `/rpc` framing, `/pty` framing incl. resize OSC + close codes 4000-4003) + `docs/ios/PROTOCOL.md` | M | The fleet builds against a written contract; backend PRs can't silently break the app |
| B3 (fast-follow) | Independent-size PTY viewer mode (second tmux attach client per remote viewer, or opt-in read-only viewer) | L | Removes the "phone shrinks desktop terminal" constraint (decision 060) |
| B4 (fast-follow) | Named/stable tunnel support in `cloudflare-tunnel.ts` | M | Stable origin; makes remote-over-internet reconnect seamless |
| B5 (future, separate design) | APNs relay for true background push | XL | Needs infra + Apple keys; explicitly out of scope; decision 084 already parks this class |
| B6 | Long-lived sessions for native clients: a client-type marker on `/auth/exchange` (e.g. `{client:"ios"}`) → longer rolling TTL (~30d) or a device/refresh-token pair (deferred in decision 133) | S–M | Keychain ≫ browser cookie as credential storage; avoids re-pairing after >24h gaps — critical for headless/Coder-style backends where a fresh QR needs shell access |

Per repo invariants: B1/B2 touch nothing under `~/.dev3.0/` layout; all changes must degrade gracefully for older clients.

## 10. Open decisions (defaults chosen; user can override)

1. **Signing & distribution**: initial signing identity is ittaiz's personal Apple account, which has a **paid Apple Developer Program membership** (decided in PR #969 review) — so TestFlight is the distribution path from day one. App Store later — the app is a client to the user's own server, same category as SSH clients, low review risk.
2. **Bundle id / name**: placeholder `com.ittaiz.dev3` (must be under the signing account's control; final value confirmed at T4.4), display name "dev3".
3. **iPad**: layouts are adaptive by construction; iPad is "supported but not tuned" in v1 (bigger win post-B3).
4. **Localization**: v1 English-only; the string catalog mirrors the web's i18n key taxonomy so ru/es port cheaply in v2.
