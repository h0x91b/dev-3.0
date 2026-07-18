# 138 — Deep TmuxClient over raw tmux grammar

## Context

tmux mechanics were smeared across the bun process: ~63 spawn call sites, 5
independent output parsers, 3 field-separator conventions (space, `|`,
`\x1f`), 16 unique `-F` format strings, and `dev3-*` session names recomputed
inline in 9+ places. Any tmux grammar change had to be chased through
multiple parsers, the 2,500-LOC handler layer was untestable without a live
tmux, and the tmux-3.6 shim contract (decision 105, v1.29.1 ELOOP incident)
was bypassable by any caller spawning `tmux` directly.

## Decision

One deep module, `src/bun/tmux/`, owns the binary, the socket, and the
grammar (spec grilled in task Seq 1018, implemented in Seq 1137):

- `client.ts` — `TmuxClient` with a typed method per used subcommand and a
  **private** argument runner (no raw-args escape hatch; a new tmux command
  means a new method plus its test). The module exports the `tmux` singleton;
  the constructor takes an injected `spawn` and default socket for tests.
- `formats.ts` — every `-F` format is a typed declaration; ONE separator
  (TAB) and ONE parser replace the five parser implementations. Free-text
  fields (titles, names, commands) are declared `.tail()` and must come last
  so an embedded separator cannot shift typed columns.
- `session-names.ts` — `dev3-*` naming + reverse parser (`parseDev3SessionName`).
- `binary.ts` — the shim/binary-selection logic moved **verbatim** from
  pty-server (decision 105: this code already broke terminals once; move,
  don't refactor). No longer exported outside the module — outside callers go
  through `tmux.selectBinary/probeVersion/dereferenceShim/binaryPath`.
- `config.ts` / `themes.ts` / `alt-click.ts` — the bundled config generator,
  Catppuccin payload and alt-click logic consolidated into the module.
- Errors: `TmuxError` (args/exitCode/stderr) for non-zero exits;
  `TmuxSpawnError` (decision 123, FDA hint) for launch failures; `bestEffort`
  option swallows only `TmuxError`.

The renderer↔pty-server resize sequence is NOT tmux grammar; its two
hardcoded copies were unified in `src/shared/resize-protocol.ts`.

Test seams, highest first: (1) the `tmux` singleton — handler tests mock this
module; (2) the injected spawn — used only by the client's own tests; (3) a
real tmux on a throwaway socket — `tmux-client-live-e2e.test.ts`, excluded
from the fast suite, runs with `test:full` in CI.

## Risks

- **Enforcement is convention-only.** The owner explicitly declined an
  automated guard test/lint rule against raw `tmux` spawns; AGENTS.md carries
  the hard rule instead. A future call site can still bypass the client —
  consciously accepted.
- Big-bang migration of all call sites in one PR; mitigated by the live-tmux
  e2e, full module unit coverage, and manual QA of the terminal flows.
- The TAB consolidation changes the format strings sent to tmux (not
  user-visible behavior). A field whose value could contain a TAB must be a
  tail field — the formats module enforces "one tail, last position" at
  declaration time.

## Alternatives considered

- Free functions instead of a class: rejected — the injected-spawn seam and
  the singleton mock pattern (mirroring `rpc.ts`) fall out of the class shape.
- Keeping per-caller parsers with a shared `tmuxArgs`: rejected — that is the
  status quo that produced 5 parsers and 3 separator conventions.
- An automated no-raw-tmux guard test: explicitly declined by the owner
  (recorded above as an accepted risk).
