# 140 — Claude sessions always get `--allow-dangerously-skip-permissions`

## Context
Claude Code exposes two distinct flags: `--dangerously-skip-permissions` (turns full bypass ON by default) and `--allow-dangerously-skip-permissions` (only makes bypass *available* to toggle into with Shift+Tab, off by default). Previously only the Plan presets carried the soft `--allow-` flag explicitly; the Auto presets carried neither, so a user in Auto mode had no way to escalate to full bypass mid-session. Bypass/Default/Accept-Edits/cost-trick presets already carry the hard `--dangerously-skip-permissions`.

## Investigation
Validated against `claude` 2.1.112 in a tmux pane: `--permission-mode <auto|default|plan|acceptEdits|bypassPermissions|dontAsk>` combined with either dangerous-skip flag all exit 0 with no conflict. `auto` is a first-class `--permission-mode` value. So the soft flag composes cleanly with every mode.

## Decision
Inject `--allow-dangerously-skip-permissions` for every claude launch in the adapter (`src/shared/agent-adapters/claude.ts`, `launchArgs`), guarded to skip when `additionalArgs` already contains `--dangerously-skip-permissions` or `--allow-dangerously-skip-permissions` (avoids a duplicate on top of the hard flag). Mirrored in the settings command preview (`src/mainview/components/global-settings/utils.ts`, `buildCommandPreview`). The adapter is now the single source for the allow flag, so the explicit copy was removed from the three Plan presets in `src/shared/types.ts` (net launch command unchanged, so no preset `version` bump).

Additionally, the three **Default** presets (`claude-default`, `-opus48`, `-sonnet5`) previously shipped the *hard* `--dangerously-skip-permissions`, which made "Default" open in full bypass — surprising for a preset named "Default". Removed the hard flag so Default now opens in Claude's normal permission mode with bypass merely available (via the adapter's `--allow-` flag). Because this is a real behaviour change, their `version` was bumped (8→9, 1→2, 1→2): `mergeConfig` in `src/bun/agents.ts` discards a stored config's `additionalArgs` only when the default version advances, so the bump is what drops the old hard flag from already-onboarded users' stored copies. Bypass/Accept-Edits/cost-trick presets keep the hard flag by design.

## Risks
Adds a bypass-related flag to every claude session, including the safe Default/Auto ones — but it only *enables the option*, it does not turn bypass on, matching the flag's own semantics. Requires a claude version that knows `--allow-dangerously-skip-permissions` (present since well before 2.1.x, and dev3 already assumes a recent claude via `--permission-mode auto`, `--effort`, `--max-budget-usd`). Non-claude agents are unaffected (flag lives only in the claude adapter).

## Alternatives considered
- Edit only the 7 Auto preset definitions (like Plan): simpler test diff, but does not cover user-created custom claude presets and would need version bumps — fails the "always, everywhere" intent.
- Replace the hard `--dangerously-skip-permissions` with the soft flag in Default/Accept-Edits presets: a semantic change (those would stop forcing bypass) that was not requested.
