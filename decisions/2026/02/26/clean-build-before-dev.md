# 004 — Always run electrobun build before electrobun dev

## Context

After adding a new RPC handler (`runDevServer`) to `src/bun/rpc-handlers.ts`, running `bun run dev` resulted in "The requested method has no handler: runDevServer" at runtime. The frontend (Vite bundle) was fresh, but the backend (Bun bundle inside the app) was stale.

## Investigation

- `bun run dev` originally ran `vite build && electrobun dev`
- `vite build` rebuilds only the **frontend** (`src/mainview/` → `dist/`)
- `electrobun dev` does **NOT** bundle the backend at all — it only launches the app from existing files in `Resources/app/`
- `electrobun build` is the only command that bundles the backend (`src/bun/` → `app/bun/index.js`) and copies views
- Result: frontend sees new RPC methods, backend doesn't — runtime error

First attempted fix (cleaning `Resources/app/` before `electrobun dev`) was worse — `electrobun dev` can't launch without the pre-built bundle, so the app wouldn't start at all.

## Decision

Changed `dev` script to: `vite build && electrobun build && electrobun dev`

- `vite build` — always produces fresh frontend
- `electrobun build` — always rebundles backend + copies views into app bundle
- `electrobun dev` — launches the app with dev features (devtools, etc.)

No `clean` step needed — `electrobun build` always overwrites its outputs.

## Risks

- Slightly longer startup due to running both `electrobun build` and `electrobun dev`. Acceptable since the build is fast.
- `electrobun build` + `electrobun dev` may duplicate some work (copying views), but correctness > speed here.

## Alternatives considered

- **Clean + electrobun dev** — breaks the app because `electrobun dev` doesn't rebundle the backend. Tried and reverted.
- **Relying on `electrobun dev` to detect changes** — not possible, `electrobun dev` doesn't bundle at all.
