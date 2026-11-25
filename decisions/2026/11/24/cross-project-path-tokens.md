# Cross-project path tokens: `path:<project>/<path>`

## 1. Context

A plain relative path in task text resolves against the task's own project (`file-path-links-in-task-text`). An agent on board A that writes "Brief: todo/x.md in AI-Work" into a task on board B leaves a path that resolves on B, where it names nothing or the wrong file. An absolute path works on one machine only and is mostly home-directory noise.

## 2. Decision

- **Grammar** (`src/shared/path-refs.ts`): `<path:a1c9fe4e/todo/x.md>`, or bare `path:a1c9fe4e/src/app.ts:12`. The qualifier is the one `seq:<project>/N` uses (8-char id prefix emitted, project name accepted). The path is `/`-separated on every OS, relative to the project root, and may not contain empty, `.` or `..` segments. A bare token drops trailing sentence punctuation and a trailing `/`. The tag is lowercase `path:` only; `Path:` is prose.
- **`path:`, not `file:`**: `file:` is a real URI scheme, which markdown autolinks and OSC 8 targets already read as a local file URL.
- **Always qualified.** A same-project path needs no token, because a plain relative path already links there.
- **Writer side.** `task.create` and `task.update` from a task on another board run `qualifyWriterPaths` after `qualifyRefsFor`. Notes, overviews and cross-project moves do the same: `decisions/2026/11/24/path-tokens-in-notes-overviews-and-moves.md`.
  - A relative path that exists under the writer project's root and not under the reader's becomes its bare token. A path both boards hold (`README.md`, `src/index.ts`) is ambiguous and stays as written.
  - An edit keeps lines already in the old description, as `qualifyEditedRefsFor` does.
  - Fenced code, indented fences included, is skipped, because a command in one must still run. A backtick line with more backticks after the opener is inline code, not a fence (CommonMark). Inline code is skipped too, unless the span is one whole path, the same rule the renderer's `wrapCodePath` uses; there a `:col` tail is dropped, so the span stays one token. In prose a `:col` tail stays as written.
  - At most 64 distinct paths are checked on disk per text.
  - Titles are not qualified, because a card title renders as plain text, where a token would read as noise.
- **Annotations never persist.** Every description, note and overview write runs `withoutAbsolutePaths`, which drops the ` (<absolute path>)` that dev3 adds for agents, so an agent that copies `task show` output back stores only tokens. Only an exact annotation, the path that token resolves to now, is dropped. An author's own `(...)` after a token stays.
- **Messages** take absolute paths instead (`absolutizeSenderPaths` in `message-commands.ts`). A message is read once, on the same machine, so portability buys nothing, and the receiving agent can open an absolute path directly. An absolute path is unambiguous, so a file both boards hold still gets the sender's path. The text is rewritten at entry, so the spill size measured at queue time still holds at delivery.
- **Readers.** Every surface that shows the text understands the token:
  - `resolveTerminalPaths` resolves it through `resolvePathRefIn`, with the same roots gate as any path. `underRoot` also refuses a join that leaves the project root.
  - `TaskRefText` and every markdown surface render it as a chip labelled with the project path. The sanitizer passes it through the reference nonce token in `markdown-urls.ts`. The label is always the real path, never the link text, because PR comment markdown is untrusted.
  - The terminal deep-link provider links it, and `activateDeepLinkUri` opens it.
  - Agents read it with its absolute path appended, `path:a1c9fe4e/x.md (/abs/x.md)`, outside fenced code. A current annotation is not added twice. Where: the launch prompt (`resolveAgentCommand`), plus `dev3 task show`, `current`, `note show` and `overview`.
  - The launch prompt rides the Windows command line, so it adds at most 512 characters (`LAUNCH_ANNOTATION_MAX_ADDED_CHARS`). Other text adds at most 2 048. `agent-command-line-budget.test.ts` covers a full-size task dense with tokens.
- **Windows.** `resolvePathRefIn` and `underRoot` take the host's path module, so the `/`-separated token joins with `\` on Windows. Tests run both under `path.win32` and `path.posix`.

## 3. Risks

- A token resolves against the project root, not a task worktree. A worktree task's new or changed file is checked, and opened, from the main checkout.
- After a project folder moves, an annotation stored before this rule existed, or copied by hand, no longer matches exactly. It stays as text and a fresh one is added next to it.
- No Windows CI job runs these tests on a Windows host. They cover Windows behaviour through `path.win32` and an explicit platform parameter.

## 4. Alternatives considered

- **`file:` as the tag**: rejected, see above.
- **Teach agents to write the token**: rejected as the only path. The protocol body is capped, and an agent that forgets leaves a dead path. The CLI qualifies for them, as it does for `seq:N`.
- **Tokens in messages**: rejected. The receiver needs a path it can open, and annotating at delivery would grow the text after the spill check.
