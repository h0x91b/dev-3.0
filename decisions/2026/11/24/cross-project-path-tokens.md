# Cross-project path tokens: `path:<project>/<path>`

## 1. Context

A plain relative path in task text resolves against the task's own project (`file-path-links-in-task-text`). An agent on board A that writes "Brief: todo/x.md in AI-Work" into a task on board B leaves a path that resolves on B, where it names nothing or the wrong file. An absolute path works on one machine only and is mostly home-directory noise.

## 2. Decision

- **Grammar** (`src/shared/path-refs.ts`): `<path:a1c9fe4e/todo/x.md>`, or bare `path:a1c9fe4e/src/app.ts:12`. The qualifier is the one `seq:<project>/N` uses (8-char id prefix emitted, project name accepted). The path is `/`-separated on every OS, relative to the project root, and may not contain `.` or `..` segments. A bare token drops trailing sentence punctuation.
- **`path:`, not `file:`**: `file:` is a real URI scheme, which markdown autolinks and OSC 8 targets already read as a local file URL.
- **Always qualified.** A same-project path needs no token, because a plain relative path already links there.
- **Writer side.** `task.create` and `task.update` from a task on another board run `qualifyWriterPaths` after `qualifyRefsFor`: a relative path that exists under the writer project's root becomes its bare token. An edit keeps lines already in the old description, as `qualifyEditedRefsFor` does. Fenced code blocks are skipped, because a command in one must still run. Titles are not qualified, because a card title renders as plain text, where a token would read as noise.
- **Messages** take absolute paths instead (`absolutizeSenderPaths` in `message-commands.ts`). A message is read once, on the same machine, so portability buys nothing, and the receiving agent can open an absolute path directly. The text is rewritten at entry, so the spill size measured at queue time still holds at delivery.
- **Readers.** Every surface that shows the text understands the token:
  - `resolveTerminalPaths` resolves it through `resolvePathRefIn`, with the same roots gate as any path. `underRoot` also refuses a join that leaves the project root.
  - `TaskRefText` and the task markdown render it as a chip labelled with the project path. The sanitizer passes it through the reference nonce token in `markdown-urls.ts`.
  - The terminal deep-link provider links it, and `activateDeepLinkUri` opens it.
  - Agents read it with its absolute path appended, `path:a1c9fe4e/x.md (/abs/x.md)`: in the launch prompt (`resolveAgentCommand`), and in `dev3 task show` and `dev3 current` (description, overview, notes).
- **Windows.** `resolvePathRefIn` and `underRoot` take the host's path module, so the `/`-separated token joins with `\` on Windows. Tests run both under `path.win32` and `path.posix`.

## 3. Risks

- A worktree task's new, uncommitted file does not exist under the project root, so a path to it stays plain when written cross-board.
- An agent that writes an annotated line back stores `path:… (/abs/…)`. Both halves still resolve on this machine, and the annotation is not added twice.
- No Windows CI job runs these tests on a Windows host. They cover Windows behaviour through `path.win32` and an explicit platform parameter.

## 4. Alternatives considered

- **`file:` as the tag**: rejected, see above.
- **Teach agents to write the token**: rejected as the only path. The protocol body is capped, and an agent that forgets leaves a dead path. The CLI qualifies for them, as it does for `seq:N`.
- **Tokens in messages**: rejected. The receiver needs a path it can open, and annotating at delivery would grow the text after the spill check.
