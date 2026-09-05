# low-battery is opt-in, and an unchosen setting touches nothing on disk

## Context

`decisions/2026/08/29/ship-low-battery-from-a-build-time-pull.md` shipped the
low-battery answer format **on by default**: an absent `lowBatteryDisabled` key read
as "on", so every start installed the skill into six agent config dirs, wrote the
Claude Code output style, selected it, and added an always-on line to dev3's managed
block in `~/.agents/AGENTS.md`. On 2026-09-05 the user reversed that: dev3 ships the
feature, it does not impose an answer format on anybody's agents.

## Investigation

The old storage cannot tell an opt-in from a default. `lowBatteryDisabled` normalized
an explicit `false` to `undefined` on load (`src/bun/settings.ts`), so the only stored
value that ever existed was `true` — the opt-out. Nobody who *wanted* low-battery has
any record of wanting it, which means there is no consent to migrate forward, and a
user who liked the format has to switch it back on once. That is the cost of the
reversal, stated rather than papered over.

The mirror problem is the leftovers: an upgrading install still has the skill dirs,
the style file and a selected `outputStyle`. Deleting them on an absent setting would
be a destructive migration on a guess — `~/.claude/skills/low-battery/` may equally be
the user's own copy from upstream, or the plugin's.

## Decision

The setting is now `lowBatteryEnabled` (`src/shared/types.ts`), and **both** booleans
are stored: `true` is "install it", `false` is "uninstall what dev3 wrote", absent is
"never asked". `installAgentSkills` (`src/bun/agent-skills.ts`) takes the same
tri-state — an omitted flag calls `applyLowBattery` not at all, so an unchosen setting
neither installs nor deletes anything. dev3's own managed block is still rewritten on
every start and carries the always-on line only when the flag is exactly `true`,
because that block is dev3's to own.

The legacy `lowBatteryDisabled` and `lowBatteryAnnounced` keys stay in the sanitizer,
unread. `~/.dev3.0/settings.json` is shared with every installed version of the app,
and stripping them would hand an older co-installed build a blank slate — it would
turn low-battery back on for someone who opted out. Their meaning (off, already
announced) is the new default anyway, so nothing reads them.

`dev3 doctor` reports the leftovers instead of removing them: "off in Settings, but an
earlier install is still on disk", with the repair being the toggle itself, on then
off. The one-time "the answer format changed" toast in `App.tsx` is gone — it
announced a default that no longer exists.

## Risks

Anyone who was on low-battery through the old default loses it silently on upgrade and
must turn it on again; there is no stored consent that would let us keep them on. An
upgrading install keeps the style selected until the user touches the toggle, so for
them the reversal only takes effect after one round trip through Settings — deliberate,
because the alternative is deleting files dev3 may not own.

## Alternatives considered

Treating an absent setting as an uninstall — rejected: it deletes a `low-battery`
skill dir that may be the user's own, and the brief for this change explicitly ruled
out inventing a destructive migration for state that cannot prove its own provenance.
Keeping `lowBatteryDisabled` and inverting its meaning — rejected: the same key would
mean opposite things in two shipped versions reading one file.
