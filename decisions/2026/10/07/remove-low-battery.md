# Remove the bundled low-battery answer format

## Context

dev3 shipped the upstream `low-battery` rules (`decisions/2026/08/29/ship-low-battery-from-a-build-time-pull.md`), later as an opt-in Settings toggle (`decisions/2026/09/05/low-battery-is-opt-in.md`). On 2026-10-07 the user asked for the feature to be removed from dev3 entirely, and for the Claude Code `outputStyle` to fall back to the default wherever dev3 had set it.

## Decision

The installer, the 130 KB generated content, the build-time generator, the Settings row, the two RPCs, the `dev3 doctor` check and the always-on line in `~/.agents/AGENTS.md` are deleted. What remains is `retireLowBattery` (`src/bun/low-battery.ts`), run at startup and by `dev3 install-skills`:

- `outputStyle` exactly `"Low Battery"` (the name dev3's copy registered) is deleted from `~/.claude/settings.json`, which is Claude Code's default. A plugin's namespaced value and any other style are left alone.
- The style file and the seven skill dirs are deleted only when `lowBatteryEnabled === true` is stored, the one proof that dev3 installed them. Afterwards `false` is stored, so the cleanup runs once and older co-installed builds — which read `false` as "uninstall" — keep it off.
- The managed AGENTS.md block is rewritten on every start anyway, so the always-on line disappears with no extra code.

The three legacy settings keys stay in the sanitizer, unread except for that proof, for the N-2 on-disk rule.

## Risks

An upgrader from the default-on era who never touched the toggle keeps the skill dirs and style file on disk: nothing proves dev3 wrote them, and an upstream copy has identical bytes. Only their `outputStyle` selection is reset — non-destructive, the user can pick the style again. A user who copied upstream's style into `~/.claude/output-styles/` by hand and selected it as `"Low Battery"` also gets the selection reset, which is exactly what was asked for.

## Alternatives considered

Deleting every `low-battery` dir that carries the upstream "GENERATED" marker — rejected: the marker is in upstream's own files too, so it cannot tell dev3's install from the user's. Keeping the toggle but hiding it — rejected by the project's no-deprecation rule.
