# 115 — Select the Codex syntax theme at launch

## Context

dev3 already selects `dev3-light` or `dev3-dark` profiles, but Codex 0.130 rejected `tui.theme` inside those profiles and the managed values were disabled. A user's global `[tui] theme` could therefore pin a light syntax theme while dev3 rendered a dark terminal, producing glaring diff backgrounds.

## Investigation

Current Codex exposes `tui.theme` as a root config value and accepts root config overrides through repeated `-c key=value` launch arguments. Codex themes can also provide `markup.inserted` and `markup.deleted` backgrounds, so selecting the compatible theme at the source is more reliable than translating every possible theme palette in the PTY stream.

## Decision

`applyCodexThemeProfile()` in `src/bun/agents.ts` continues selecting the theme-specific dev3 profile, then appends `-c 'tui.theme="github"'` for light mode or `-c 'tui.theme="dracula"'` for dark mode. The override is appended after preset `additionalArgs`, making the dev3 UI theme authoritative without rewriting the user's global Codex config.

## Risks

Using `/theme` can still change the active Codex session, but the next dev3 launch restores the app-matched theme. Codex sessions launched outside dev3 keep the user's global theme unchanged; older Codex versions that do not understand `tui.theme` remain a compatibility risk, mitigated by the same root setting having existed before profile-based theme injection.

## Alternatives considered

Putting `tui.theme` back into managed profiles was rejected because affected Codex versions reject that schema. Rewriting the user's global config was rejected because it would change unrelated Codex sessions, and relying only on terminal background detection was rejected because an explicit global syntax theme can override adaptive defaults and supply its own diff backgrounds.
