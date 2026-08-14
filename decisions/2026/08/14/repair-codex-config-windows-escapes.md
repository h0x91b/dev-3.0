# Repairing another tool's config file: unescaped Windows paths in ~/.codex/config.toml

## Context

dev3 patches `~/.codex/config.toml` (trust entries, permission profiles, socket
allowlist) by text manipulation, to preserve the user's comments and formatting.
Every path went into a TOML *basic* string raw, so on Windows `[projects."C:\Users\user/.dev3.0/worktrees"]`
made `\U` an escape sequence; TOML demands eight hex digits after it and the
whole file dies at parse time. Codex then refuses to start at all — not just
inside dev3 tasks, anywhere on that machine. The mixed `\...\.../...` separators
in the same key came from string concatenation of a native home with a POSIX
suffix.

## Investigation

`ensureCodexConfig` (src/bun/codex-config.ts) interpolated `${path}` into
`"..."` at six sites, and both entry points (`ensureCodexConfigFile`,
`ensureCodexTrust` in src/bun/agents.ts) built paths with `${home}/...`. On a
parse failure the function logged a warning and returned the content unchanged,
so an already-broken file stayed broken forever.

## Decision

1. `tomlBasicString()` quotes every value dev3 writes; paths are composed with
   `join()` so Windows gets native separators. On POSIX the escaper is a no-op,
   so macOS/Linux output is byte-identical (asserted in
   `codex-config-windows-paths.test.ts`).
2. `repairWindowsPathEscapes()` is a **surgical textual repair**, not a
   round-trip: the file cannot be parsed, so it cannot be re-serialized. It
   rewrites only lines matching dev3's own shapes (`[projects."..."]`,
   `[permissions...]` headers, `"<winpath>" = "read|write|allow|deny"`,
   `allow_unix_sockets = [...]`) and only the quoted spans that look like a
   native Windows path. `repairIfParsable()` applies it **only if the result
   parses**; otherwise the file is returned untouched and dev3 skips patching, as
   before. Before the first repair the original is copied to
   `config.toml.dev3-backup` (copy, never rename; never overwritten).

## Risks

- A user who hand-wrote a `[projects."C:\..."]` header gets that line escaped
  too. It is indistinguishable from ours and was unparsable either way, so the
  alternative is leaving codex dead.
- An older installed dev3 on the same Windows machine will not recognise the
  repaired native-separator keys and will append its own broken block again,
  re-killing codex until it is updated. Unavoidable: the old writer is the bug.
- The repair cannot understand a file broken for any other reason — it declines
  and says so in the log rather than guessing.

## Alternatives considered

- Parse and re-serialize the whole file: impossible here (it does not parse) and
  it would destroy the user's comments and ordering even when it did.
- Write TOML literal strings (`'C:\Users\user'`): fewer escapes, but it silently
  breaks on a path containing a single quote and diverges from every existing
  line in the file.
- Leave existing files broken and only fix new writes: leaves every current
  Windows install with a codex that will not start.
