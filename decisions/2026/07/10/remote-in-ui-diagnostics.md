# 122 — In-UI diagnostics for remote/mobile

## Context

Browser remote mode (`dev3 remote`), especially on phones, has no devtools. When
the renderer faulted the user saw nothing actionable: a React crash unmounted the
tree to a blank page; a stuck bootstrap spun a bare `t("app.loading")` spinner for
up to the 120s RPC timeout; and `window.onerror` / `unhandledrejection` / WebSocket
failures went only to `console`, GA4 (`analytics.ts`), and a backend log file — none
of which a phone user can read or report from.

## Decision

Added an in-UI diagnostics layer (bible §5.5, decision `UX_DECISIONS 2026-07-10`):

- `src/mainview/diagnostics.ts` — framework-agnostic ring buffer (cap 50, deduped),
  fed by the global handlers (`main.tsx`), the React boundary, and the RPC transport
  (`rpc.ts` now emits `dev3:rpcStatus` + records WS/timeout failures; exports
  `getRpcConnectionState()` / `reconnectRpc()`).
- `components/RootErrorBoundary.tsx` — wraps the **providers + App** in `main.tsx`
  (not just `App`) so a crash inside `I18nProvider`/`MobileProvider` still renders a
  visible fallback. It is deliberately provider-free and **English-only** (a documented
  i18n exception: the translation provider may be the thing that threw).
- `components/BootstrapScreen.tsx` — replaces the two bare loading spinners with a
  phase label + a ~12s stuck-timeout → Retry/Reload + last captured error.
- `components/DiagnosticsPanel.tsx` + `components/DiagnosticsIndicator.tsx` — the full
  viewer, opened from a floating pill that renders **only in remote mode and only when
  `errorCount > 0`** (earned, not permanent chrome; absent in the desktop shell).
- `index.html` — a static pre-React loader inside `#root` (replaced on mount) with a
  20s "couldn't start" fallback, so a failed bundle shows a hint + Reload, not a blank.

## Risks

- The boundary reads token classes; if `index.css` itself failed to load the surface
  falls back to inline neutral colors (`var(--color-base, #0b0e14)` etc.).
- Diagnostics recording must never throw; listener notification is wrapped in try/catch
  and the buffer is capped so a crash-loop can't grow memory.

## Alternatives considered

- **Permanent header/menu "Diagnostics" button** — rejected: toolbar-button creep, and
  it is dead on a crashed/unmounted tree.
- **External error reporter (Sentry-style)** — rejected: doesn't let the phone user see
  and copy the fault themselves, and adds a dependency.
- **Boundary inside the providers** — rejected: would not catch a provider crash, the
  exact blank-page case this fixes.
