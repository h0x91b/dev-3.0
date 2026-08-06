# 037 — Custom folder picker replaces native dialog

## Context

`pickFolder` used `Utils.openFileDialog` from `electrobun/bun`. In headless/
remote mode the shim in `src/bun/electrobun-platform.ts` stubs this out to
`return null`, so the "Add Project" browser flow was broken — users could never
select a folder through the remote access UI. The old browser-side fallback in
`rpc.ts` was `prompt("Enter folder path:")`, which is not a real picker.

## Investigation

Evaluated five React tree/file-picker libraries (see task description). Ruled
out `react-arborist` (no native async loader, maintenance slowing), SVAR File
Manager (non-Tailwind CSS-variable stack), Kibo/Magic UI (prototype-grade),
and the Ark UI / React Aria primitives (more plumbing for the same outcome).

`@headless-tree/react` had the best architectural fit: its
`getChildrenWithData` data loader is designed for exactly this pattern — one
IPC round trip per expand, with built-in caching and load-state APIs — and it
is fully headless, so the UI lives in our Tailwind + shadcn-style shell.

## Decision

- Removed the RPC `pickFolder` (handler + schema + tests + `rpc.ts` browser
  override). Added `listDirectory({ path?, includeFiles?, showHidden? })`
  returning `FolderListing { path, parent, home, entries, error? }` — see
  `src/bun/rpc-handlers/app-handlers.ts`.
- Built `FolderPickerHost` in `src/mainview/components/FolderPickerModal.tsx`,
  mounted once at the App root. Renderer code calls `openFolderPicker(opts)`
  from `src/mainview/folder-picker.ts`, a tiny promise/listener bridge.
- Both modes (Electrobun and browser) use the same picker — there is no
  native-dialog branch any more. Callers: `AddProjectModal`, `GlobalSettings`.

## Risks

- `listDirectory` reads the filesystem via `node:fs`. On macOS this requires
  Full Disk Access (same as tmux spawning — already documented). If the grant
  is missing, listings return `{ error }` instead of throwing.
- `statSync` follows symlinks — a directory symlink is treated as a directory.
  This matches user expectation but means a loop of symlinks can expand the
  tree indefinitely; the picker relies on the user to stop expanding.
- Loss of the native macOS picker means no "recent places", "favourites",
  or drag-drop from Finder. The path input supports paste/Enter as a quick
  alternative.

## Alternatives considered

- Keep the native dialog for Electrobun and add a second picker for remote —
  rejected. Two pickers = double maintenance and a user-visible behaviour
  split between modes. The no-`deprecated` rule from global CLAUDE.md
  discourages dual-path shims.
- `react-arborist` — more popular, but we would re-implement lazy loading on
  top of a `data` prop and ship ~30-50 KB more JS including react-dnd.
- SVAR File Manager — batteries-included UI, but its CSS-variable theming
  fights our Tailwind design tokens.
