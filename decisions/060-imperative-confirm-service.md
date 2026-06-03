# 060 — Imperative promise-based confirm() service

## Context
The app now runs both as an Electrobun desktop shell and as a headless remote served to a browser (`dev3 remote`). The old confirmation path used the native `Utils.showMessageBox` (a `showConfirm` RPC into the bun process) with a `window.confirm` fallback in the browser transport. Native message boxes cannot render in browser mode, and `window.confirm` is a blocking, untheme-able popup. We needed one in-app confirmation primitive callable from components, hooks, and plain util modules (e.g. `confirmTaskCompletion.ts`).

## Decision
Added `src/mainview/confirm.tsx`: a module-level `confirm({ title, message, danger? }) => Promise<boolean>` backed by a single `<ConfirmHost />` mounted once in `App.tsx`. A module-level `listener` connects the imperative call to the host's `setState`. This keeps every call site a near drop-in for the removed `api.request.showConfirm` (same `{ title, message }` shape, returns a Promise) while being plain React that renders identically in desktop and browser. Removed the `showConfirm` RPC handler, its `AppRPCSchema` entry, and the `window.confirm` browser override.

## Risks
- Module-level singleton means only one dialog at a time; concurrent `confirm()` calls would overwrite the pending one. Acceptable — confirmations are user-driven and serial in practice.
- If `<ConfirmHost />` is not mounted, `confirm()` resolves `false` (fail-closed) rather than blocking.

## Alternatives considered
- **React Context + `useConfirm` hook:** rejected because util modules (`confirmTaskCompletion.ts`) and non-component code cannot use hooks; a module-level function is callable everywhere.
- **Keep `window.confirm` in browser mode only:** rejected — blocking, untheme-able, inconsistent UX between the two run modes.
