# Terminal link providers on an internal `terminalLinks` contribution slot

## Context
Phase 8, PR 1 of the GUI-on-plugins plan (`decisions/2026/11/21/gui-plugin-slots-and-api-versioning.md`).
Terminal links (file paths with line:col, OSC 8 hyperlinks, bare `dev3://` links, plain URLs for touch) were
wired one by one in `TerminalView`. They were already provider-shaped, so they move onto a slot. Internal only:
no manifest kind, no public service, no API version bump. The renderer, glyph atlas, input path and tmux
layout stay host-owned.

## Investigation
ghostty-web's `LinkDetector.scanRow` awaits every registered provider in turn, pushes all links into one array
and caches it per row. A provider that throws rejects the whole row, so one broken provider would kill every
link on it. There is no `unregisterLinkProvider`. Inside an OSC 8 link the cache keys cells by hyperlink id,
so the later provider wins a cell both claim, which is why OSC 8 must come after file paths.

## Decision
- `src/mainview/terminal-links/registry.ts`: a contribute-kind `TerminalLinksRegistry`. A def has `order` (click
  registration order) plus optional `touchOrder` / `refOrder`, because tap and preview-card precedence already
  differed from click precedence. `create(env)` returns optional `provider`, `underlines`, `touchAt`, `refAt`, `dispose`.
- `host.ts` `installTerminalLinks` registers ONE composite provider with ghostty. It walks a snapshot of the
  live providers in `order` and concatenates their links. That is what ghostty does with several providers,
  so click and hover behaviour is unchanged. Every call into a provider is guarded: a throw logs
  `[terminalLinks] <id> <what> failed` once per provider and callback (`refAt` runs per mousemove,
  `underlines` per redraw) and that provider contributes nothing. A slot change clears the log memory.
- The snapshot, the underline feed (one shared buffer scan, `sharedScanLinks`), and the tap and ref rankings are
  rebuilt only when the slot changes. Nothing reads the registry per row, keystroke or frame.
- `builtins.ts` holds the four built-ins, `builtin:file-paths`, `builtin:osc8`, `builtin:deep-links` and
  `builtin:plain-urls`, registered by the required `builtin:terminal-links` plugin. The OSC 8 hover tooltip
  belongs to the osc8 provider.

## Risks
- A slot change rebuilds every instance in every open terminal, which drops the file-path resolution cache.
  Today that only happens at startup. If extensions ever register at runtime, diff the snapshot instead.
- A row scan in flight during a rebuild can still call the old instances, and ghostty does not invalidate its
  per-row link cache, so rows already scanned keep their old links until their content changes. Startup only today.
- The env carries the raw `Terminal`. That is fine internally, but it is not a public contract.

## Alternatives considered
- One ghostty registration per provider. With no unregister, a removed provider would linger, and a throwing
  provider would still break the row.
- Keeping the wiring in `TerminalView` and only listing the providers. That leaves no seam for the opening track.
