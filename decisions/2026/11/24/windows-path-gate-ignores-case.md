# The file-link path gate ignores case and slash direction on Windows

## 1. Context

Every path a terminal or task-text link opens passes `isUnder` in `src/bun/rpc-handlers/terminal-paths.ts`, against the home directory, the temp directories and the project roots. It compared raw strings. `path.win32.resolve` keeps a lowercase `c:` as written, and a project root stored as `C:/Users/me/proj` never matched the backslash form of a path under it, so on Windows such a path was refused as outside the allowed roots and never linked.

## 2. Decision

`isUnder` resolves both sides with the host's path module and, when the separator is `\`, lowercases both before the prefix check. On POSIX it resolves but keeps case. Tests run under `path.win32` and `path.posix` through the `pathApi` parameter, the same pattern `underRoot` uses.

## 3. Risks

- NTFS can be made case-sensitive per directory (WSL-created folders). There a differently cased path could be admitted for a sibling that is not under the root. Both paths still have to sit under an allowed root once folded, so the gate cannot widen past the same root spelled differently.
- No Windows CI job runs this. The behaviour is covered only through `path.win32` on a POSIX host.
- macOS volumes are case-insensitive by default too; they keep the exact-case compare, as before.

## 4. Alternatives considered

- **`realpathSync.native` on both sides**: returns the on-disk case on Windows, but fails for a path that does not exist yet and costs a syscall per root per candidate.
- **Normalizing project paths when they are saved**: would not cover paths already in `projects.json`, the home directory, or a lowercase path in agent output.
