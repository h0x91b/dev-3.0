# Ship the share-artifact skill with a CLI inliner instead of a bundled script

## Context

Publishing a dev3 HTML artifact as a link (gist + preview URL) existed only as a
hand-written skill on one developer's machine, under the misspelled directory name
`dev3-share-artefact`. Renaming that directory helps nobody else: the skill was never part
of `installAgentSkills()`, so no user ever received it at all. The workflow itself is the
valuable part — gists are flat and text-only, so the multi-file artifact has to be folded
into one file first, and that folding was a 272-line Python script living next to the skill.

## Decision

`dev3-share-artifact` is now a managed skill installed into all six agent skill directories
(`src/bun/agent-skills.ts`), and the folding step is a first-class CLI command,
`dev3 inline-html` (`src/cli/commands/inline-html.ts`), ported from the Python script.

The command needs no socket — it is a pure file transform — and owns two new public exit
codes: `13` a referenced local file is missing, `14` a credential-shaped string is embedded.
Both refusals print the full JSON report and write nothing.

`MANAGED_SKILL_FILES` is now the single source of the installed skill list that
`dev3 install-skills` prints (it had drifted: `dev3-tmux` and `ask-dev3` were missing).

The misspelled `dev3-share-artefact` directory is deliberately **not** cleaned up in code.
It only ever existed on the one machine where the skill was written by hand, so a startup
path that deletes a directory dev3 never created would carry all the risk of a destructive
migration for zero users.

## Risks

The port is a rewrite, not a wrapper: regex-for-regex equivalent, but a difference in
JavaScript vs Python regex semantics would show up as an asset silently left external
rather than inlined. `src/cli/__tests__/inline-html.test.ts` pins the behaviours that matter
(stylesheet/script/media inlining, `url()` rewriting inside CSS, shell marker retention,
`</script>` escaping, both refusals).

## Alternatives considered

- **Ship the Python script next to `SKILL.md`** (as `PROTOCOL.md` already is). Cheapest and
  one-to-one with the original, but it makes `python3` a hard dependency of a dev3 feature on
  every platform, including Windows machines that have none.
- **Skill text only, agent inlines by hand.** No new code, but the agent re-invents the
  inlining every run and the secret scan — the one part that must not be improvised —
  disappears.
