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

## Follow-up: who else writes `[projects."<path>"]`

Verified on the reporter's Windows box after the fix landed. Two facts the next
agent should not have to re-derive:

- **`codex-config.ts` is the only writer in THIS repo, but not the only writer of
  the file.** The `[projects.*]` trust table is Codex's own feature — dev3 merely
  pre-seeds it so the trust dialog never appears. Anything reasoning about that
  table must expect entries dev3 never wrote.
- **The pre-fix writer re-broke healthy files.** `ensureCodexConfig` before this
  change re-emitted values it had just PARSED — a correctly escaped
  `"C:\\Users\\user\\.dev3.0\\sockets"` decodes to a native path and was written
  straight back raw, so a hand-repaired config stopped parsing again on the next
  launch. Demonstrated by running the pre-fix function on a healthy config: its
  output carries both spellings and does not parse, the current one carries a
  single escaped line and does. This, not two different build vintages, explains
  a key changing from mixed separators to all-backslash on the reporter's box —
  every sha live that day composed the path identically, by concatenation.
  **Consequence:** hand-repairing while running a pre-fix build is futile.

- **One rewrite stayed unexplained.** Between two runs on the reporter's machine
  the same key changed from `C:\Users\user/.dev3.0/worktrees` (mixed separators)
  to `C:\Users\user\.dev3.0\worktrees` (native), still unescaped. Ruled out: the
  hand repair we gave him (it doubles backslashes and never touches `/`, and it
  ran afterwards), and Codex itself (it aborts on the parse error before writing,
  and it would have written a correctly escaped string). What remains is a dev3
  build composing the path natively without escaping — most plausibly a dev build
  from a parallel branch. The falsifiable check for whoever sees this next: a
  freshly written *unescaped* entry produced by a build that already contains
  `tomlBasicString`. That would mean a second writing path exists in our code.

## Follow-up: the Windows job the merge could not gate

`windows-proof` runs POST-MERGE, so #1369 merged on green REQUIRED checks and only
then turned `main` red — and because that workflow gates the publishers, the canary
channel published nothing until the follow-up landed. The defect it caught was real
and macOS could not see it: paths were composed with node's `join`, which answers in
the HOST's dialect, so a POSIX fixture became `\Users\x\.codex\skills` on
windows-latest. `joinLike()` now joins in the dialect of the path being extended;
node's `join` stays only where a real filesystem path is needed. Anything added to
that Windows job inherits the same gap: green required checks do NOT mean the
Windows leg passed.
