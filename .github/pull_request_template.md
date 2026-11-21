<!-- 1–3 sentences: what changes and why. Link the issue if one exists. -->

## Checklist

Full rules live in [`AGENTS.md`](https://github.com/h0x91b/dev-3.0/blob/main/AGENTS.md) and [`CONTRIBUTING.md`](https://github.com/h0x91b/dev-3.0/blob/main/CONTRIBUTING.md); this is the short list of things reviews most often bounce on. Delete the lines that do not apply.

- [ ] Changelog entry under `change-logs/YYYY/MM/DD/` dated to the day you wrote it (never moved later) (`feature-` entries need a `Short:` line)
- [ ] Rebased on current `origin/main`
- [ ] `bun run lint` clean and `bun run test:full` green — the plain `bun run test` skips the slow e2e suites that CI runs
- [ ] If this change makes an existing `decisions/` record's claims false: supersede note added, new record written
- [ ] If a surface, action, search token, or shortcut changed: the matching registries updated (`docs/ux/`, `src/mainview/keymap.ts`, the search help in `i18n/translations/*/help.ts`, `ask-dev3`, tips)
- [ ] User-facing strings go through `t()` and exist in all three locales (en / ru / es)
- [ ] UI change: manual browser QA done; screenshots taken in streamer mode (`&streamer=on`)
- [ ] New dependency: pinned to an exact version
- [ ] PR is out of draft before requesting review
