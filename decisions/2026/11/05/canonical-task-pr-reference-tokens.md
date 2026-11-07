# Canonical task and PR reference tokens: `<seq:N>` and `<pr:N>`

## 1. Context

Agents and coordinators named other tasks as "seq 115", "#115", "seq:115", "task 115" and more. `#115` also collides with GitHub PR and issue numbers, and none of the forms was clickable anywhere in dev3.

## 2. Investigation

- CommonMark reads `<seq:115>` as a URI **autolink** (scheme `seq`), so markdown renderers, Claude Code's included, show it as `seq:115` and may emit it as an OSC 8 target. The parser therefore also accepts the bare `seq:N` / `pr:N` and the same strings as an href.
- Streamdown passes autolinks through `rehype-sanitize`, which strips the unknown scheme. The result is `seq:115 [blocked]`. Passing a `urlTransform` does not help, because sanitize runs first. Ref links now use the existing nonce-token trick in `pr-review/markdown-urls.ts` (`REF_TOKEN_PREFIX`), and the token can only unwrap to a valid reference.
- The terminal already had an in-app link provider for `dev3://` (underline, Cmd/Ctrl+click, touch sheet). References reuse it.
- Description, overview, notes and traffic bodies render as plain text, so links there come from one `TaskRefText` component.

## 3. Decision

- **Grammar**: `src/shared/task-refs.ts`, one parser and formatter with tests. `<seq:N>` is a task in the project of the text that carries it. `<seq:proj/N>` is a task in another project, where `proj` is the first 8 chars of the project id (approved by Arseny via the coordinator); the resolver also accepts the project name. `<pr:N>` is a PR in that project's GitHub repo. Legacy prose (`#N`, "seq N", "task N") is not recognised. `--task` also accepts a pasted `<seq:N>` (`normalizeTaskArg`).
- **Emission**: every agent-facing source emits the tokens:
  - the protocol body, the coordinator brief and board, and the message envelope (`<from-task><seq:N></from-task>`, qualified across projects)
  - PR-watch notices, the subject help, ask-dev3, and CLI sentences
- **Not changed, deliberately**:
  - CLI flag syntax `--task seq:N`, which already parses as a reference
  - UI chrome badges such as `#115` on cards, structured fields such as `Seq: 115`, and OS notification titles
  - review-task titles (`Review of #N`), which are labels rendered in card chrome, not prose
- **Resolution**: the `resolveTaskPrRef` RPC (`src/bun/task-pr-refs.ts`). A PR URL comes from the board's own PR records when it can, and from GitHub only as a fallback.
- **Rendering (step 1, links)**:
  - task description, AI notes, overview (hover preview and active row), traffic detail subject and body, task transcript markdown, and the terminal (plain text and OSC 8)
  - toasts and clickable list rows stay plain, because a link inside a click target fights the target
- **Step 2 (popovers)**: a hover preview on the same links, loaded lazily through the `previewTaskPrRef` RPC with a 15 s renderer cache (`task-ref-preview.ts`).
  - Task (`TaskRefPreviewCard.tsx`): the task's kanban card, read-only and built from the board's own pieces: status strip, identity row (priority, `#seq`, agent and config via `taskCardAgent`), `TaskCardRail` in its new `readOnly` mode, labels, `TaskPrBadges`, and the card's action strip with "Open task". Under the title: overview, the last 2 notes, up to 3 images and 3 artifacts. The preview RPC therefore ships the task itself plus its resolved labels and custom column. Hover-only; on touch the tap opens the task.
  - Inline links are chips in the card's `#seq` ink on an accent tint; a PR chip leads with the card's PR glyph, drawn by a CSS pseudo-element so copied text keeps the plain token.
  - PR: the card badge's own `TaskPrStatusPopover`, whose `taskId` became optional and which gained `onOpen` (lazy load) and `onRefresh` (re-read GitHub instead of a task cache). The status comes from the owner task's polled cache when it is the same PR, otherwise from GitHub through the user's own `gh` account.
  - Terminal: links are canvas pixels, so `terminal-ref-hover.ts` reports the hovered cell and `TaskRefFloatingPreview` follows it. The PR side there is a compact card (the board's PR badges, title, CI, "Open PR"), because the full popover needs a React trigger. The canvas cannot style a link, so the hovered one gets the same chip tint as an overlay over its cells.
  - No popover: toasts, HTML artifacts, OS notifications (see Risks).

## 4. Risks

- A bare `seq:N` in the middle of prose is now a link. That is intended, since it was never anything else.
- A bare token in cross-project text resolves on the reader's context project. Emitters qualify whenever they know the projects differ (`formatTaskRefFor`).
- HTML artifacts get nothing. They are sandboxed agent HTML, where `<seq:115>` even parses as an unknown element.
- Telemetry: nothing new leaves the machine, because resolution is a local RPC.

## 5. Alternatives considered

- **`#N` as canonical**: rejected, because it collides with GitHub.
- **`task:N`**: rejected, because `seq:` is already the CLI handle.
- **A project name as the qualifier**: rejected as the emitted form, because names change and may contain spaces. It is kept as a lenient input.
- **Chips under the text instead of inline links**: rejected, because they lose the sentence.
