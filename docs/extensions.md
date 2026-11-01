# Writing a board-view extension

A dev3 **extension** adds board views: new ways of showing a project or space board next to Kanban and Table.
An extension is a folder with two files and no build tooling required. A complete working example lives in
[`examples/board-view-extension`](../examples/board-view-extension).

> **Extensions are not sandboxed.** They run in the dev3 window with the same rights as dev3 itself. dev3 asks for
> consent once, when an extension is first installed, and every extension can be switched off at once (see below).

## The folder

```
my-extension/
├── dev3-extension.json   the manifest — read without running any code
└── index.js              one prebuilt ES module
```

### `dev3-extension.json`

```json
{
  "id": "focus-list",
  "name": "Focus list",
  "version": "1.0.0",
  "publisher": "Your name",
  "engines": { "dev3": "^1.0.0" },
  "contributes": { "boardViews": [{ "id": "focus", "label": "Focus list" }] },
  "main": "index.js"
}
```

| Field | Rule |
|---|---|
| `id` | 2–64 chars of `a-z`, `0-9`, `-`. Becomes the install folder name. `builtin` and `dev3` are reserved |
| `name`, `publisher` | Shown in Settings and in the consent dialog (max 80 chars) |
| `version` | Semver, e.g. `1.2.0` |
| `engines.dev3` | A semver range over the **dev3 extension API version** (currently `1.0.0`, shown in Settings → Extensions). It tracks the board contract below, not the app version. A range this app does not satisfy keeps the extension installed but **incompatible** and off |
| `contributes.boardViews` | 1–16 views, each `{ id, label }`. The registered id must be `<extension id>:<view id>` |
| `main` | Must be `index.js` |

### `index.js`

The default export is a [Cordis 4](https://github.com/cordiverse/cordis) plugin (dev3 pins `4.0.0-rc.11`).
`react`, `react/jsx-runtime`, `react-dom` and `cordis` are **provided by dev3** through an import map — import
them by their bare names and do not bundle them. Everything else must be inside this one file: relative imports
and other packages do not resolve.

```js
import { createElement as h, useEffect, useReducer } from "react";

function useBoard(ctx) {
  const [, bump] = useReducer((n) => n + 1, 0);
  useEffect(() => ctx.on("board/changed", bump), [ctx]);
  return ctx.board;
}

function MyView({ ctx }) {
  const board = useBoard(ctx);
  return h("ul", null, board.tasks().map((t) => h("li", { key: t.id, onClick: () => board.openTask(t.id) }, t.title)));
}

export default {
  name: "focus-list",
  inject: ["board", "boardViews"],
  apply(ctx) {
    ctx.boardViews.register({ id: "focus-list:focus", label: "Focus list", component: MyView, supportsNarrow: true });
  },
};
```

Bundling JSX or TypeScript is fine — emit one ESM file with `react`, `react-dom` and `cordis` marked external
(esbuild: `--format=esm --bundle --external:react --external:react-dom --external:cordis --jsx=automatic`).

## The board contract

`inject: ["board", "boardViews"]` makes the plugin start once a board is on screen and stop when it leaves.

- **`ctx.boardViews.register(def)`** — `{ id, label, component, supportsNarrow, Options?, defaultLayout? }`.
  `component` and `Options` (the content of the board's "View options" popover) receive `{ ctx }`.
  Registration is undone automatically when the plugin stops. An id that is not declared in the manifest, or one
  that another view already owns, makes dev3 unload the extension and mark it **Failed to load**.
- **`ctx.board`** — the board on screen: `scope`, `formFactor` (`wide` / `narrow`), `query` / `setQuery()`,
  `tasks()` (scope ∩ board query, every status), `scopeTasks()`, `matches(task, query)`, `columns()`, `labels()`,
  `agents()`, `projects()`, `preferences()`, `layout(viewId)` / `setLayout(viewId, value)` (persisted per board and
  form factor), `TaskCard` (the real dev3 card component), and the actions `openTask`, `openContextMenu`, `moveTask`,
  `setPriority`, `setLabels`, `createLabel`, `createTask`, `launch`, `remove`. Destructive actions still go through
  dev3's own confirmations.
- **`ctx.on("board/changed", fn)`** fires after every change to the board's data.

The source of truth for the types is `src/mainview/board-views/board-service.ts` and `registry.ts` in this repository.

## Installing

Settings → Extensions → **Install from folder…** (desktop app only). dev3 validates the manifest, shows what the
extension will be able to do, and copies `dev3-extension.json` and `index.js` into `~/.dev3.0/extensions/<id>/`.
Installing a newer version from the same publisher skips the consent dialog; a different publisher asks again.
A folder copied into `~/.dev3.0/extensions/` by hand shows up as **Not trusted** and runs only after you review it.

Remote browser sessions (`dev3 remote`) run extensions that are already trusted, but cannot install, trust or
enable them.

## When an extension breaks dev3

- Settings → Extensions → **Third-party extensions** off turns every extension off immediately.
- The crash screen and the "board failed to load" screen offer **Restart with extensions off**.
- Launching dev3 with `DEV3_EXTENSIONS=off` in the environment keeps them off for that launch.
- A view that throws while rendering falls back to Kanban on its own; your view choice is kept.

## Privacy

dev3's anonymous telemetry records which board view is active only as `builtin:<id>` or `third_party` — never an
extension's id or name.
