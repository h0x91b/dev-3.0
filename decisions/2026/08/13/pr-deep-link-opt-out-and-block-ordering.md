# PR deep-link opt-out, block ordering, and symmetric id encoding

## Context

The origin-task deep link (#1339, `pr-origin-task-deep-link.md`) shipped always-on
and assembled the handoff prompt as `base + deepLink + merge`. Review of the merged
branch (h0x91b/dev-3.0#1340) found three things worth fixing and one policy gap: a
public PR advertises dev3 to everyone who reads it, with no way to opt out.

## Investigation

Observed in a live task pane: with `autoMerge: true` the auto-merge sentence landed
on the same line as the block's last element, inside the markdown the agent was told
to copy verbatim. Separately, `buildTaskWebLink` percent-encoded the task id while
`buildTaskDeepLink` did not, so the two links in one footer could resolve differently.

## Decision

- `GlobalSettings.prOriginTaskLink` (default on, `?? true` style — only an explicit
  `false` is stored) gates the block; `createPullRequest` reads it and passes an empty
  section when off. Surfaced in Settings → Tasks, and the footer names that path so a
  reader of the PR knows where it comes from.
- The block is assembled LAST (`base + merge + deepLink`) and opens with a blank line,
  because `---` under a text line is setext syntax and would render an `<h2>`.
- `buildTaskDeepLink` / `buildProjectDeepLink` now percent-encode the id and
  `parseDeepLink` decodes it, so the scheme link and the web link agree.
- `docs/open.html` resolves `new-task` before `task`/`project`, since it is the only
  intent that also carries `project`. `src/bun/__tests__/open-page-grammar.test.ts`
  pins the page's literals to the module so the third copy cannot drift silently.

## Risks

- Decoding in `parseDeepLink` changes how a link containing a literal `%` parses.
  Ids are UUIDs, so no existing link is affected, and a malformed sequence falls back
  to the raw string instead of throwing.
- The opt-out is global, not per project. If someone wants the link on internal repos
  and off on public ones, this does not cover it — deliberately, until asked for.

## Alternatives considered

- **Keep the block first and the merge sentence last.** Rejected: the block ends the
  prompt naturally and anything trailing it reads as part of the quoted markdown.
- **Per-project setting.** More precise, more surface; the global switch answers the
  actual complaint (do not advertise dev3) with one control.
- **Drop the raw `dev3://` line to shorten the footer.** Rejected: it is the fallback
  when the https page is unreachable, which already happened once.
