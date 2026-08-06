# 164 — Terminal backend identity codec (MIG-003)

## Context

The tmux-removal roadmap (seq 1141) needs the backward-compatible value
semantics of a future "which terminal backend runs this session" field frozen
*before* the field is persisted, so the eventual schema/loader/migration work
(MIG-003 → later) has a single, tested contract to build on. The risk is that
persistence and default-selection logic each reinvent "missing means legacy
tmux", drift apart, and a stray path silently promotes a record to `native`.

## Decision

Add a pure, isolated codec at `src/shared/terminal-backend-identity/`
(`index.ts` + `fixtures.ts` + `__tests__/codec.test.ts`), with no production
importer. It is identity only — no capabilities, versions, negotiation, or
`TerminalBackend` interface:

- `decodeTerminalBackend(source)` — missing field → effective `tmux` with
  `present: false` (absence preserved); explicit `tmux`/`native` →
  `present: true`; unknown string / wrong type / non-object container → a typed
  `{ ok: false, code }` failure. Never silently selects `native`, never falls back.
- `encodeTerminalBackend(source, decoded)` — record-level inverse; a legacy
  decode copies the record WITHOUT backfilling `tmux`; never mutates input.
- The field name lives here as `TERMINAL_BACKEND_FIELD` on purpose; attaching it
  to the on-disk `Task`/`Project` schema is a deliberate follow-up.

## Risks

- The tests were initially orphaned from CI (the three vitest configs root at
  `src/mainview` / `src/bun` / `src/cli`, none discovers `src/shared`). Resolved
  by the persistence follow-up: they now live in `src/bun/__tests__/terminal-backend-identity-codec.test.ts`
  and run in the existing bun shard — see decision 165.
- Freezing the field name now is a light schema commitment; kept private to the
  module so it can still change before any on-disk write exists.

## Alternatives considered

- **Put the tests under `src/bun/__tests__/` (like the parity corpus, decision
  161)** — rejected: the codec is genuinely shared (persistence + UI will both
  read it), so it belongs in `src/shared`; the ticket pins the location there.
- **Add the shared vitest project + CI shard in this task** — rejected: touches
  `package.json` and `.github/workflows/build.yml`, expanding beyond the ticket's
  isolation boundary; the persistence follow-up instead moved the tests into the
  existing bun shard (decision 165).
- **Backfill `tmux` onto legacy records on encode** — rejected: rewrites
  untouched on-disk records and breaks the `~/.dev3.0` no-silent-rewrite rule.
