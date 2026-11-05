# A gone custom agent path saved before paths became strict falls back to PATH

## Context
#2166 made a user-set custom executable strict: missing or not executable fails every launch instead of quietly running the `claude` on PATH, because that would run a different program than the one chosen. Before it, a missing custom path fell back to PATH silently. Paths saved under that lenient rule are typically nvm/asdf paths that a Node upgrade removed months later, while `claude` has since been installed another way. Applied to them, strictness bricks a working setup on the day of the update.

## Decision
Strictness follows the path's provenance. `setAgentBinaryPath` (which already refuses a missing or non-executable file) also records the path in `strictAgentCustomBinaryPaths[agentId]`; only a custom path equal to that entry is strict (`isStrictCustomPath` in `src/bun/executable.ts`). Any other custom path that no longer works is *stale* (`staleCustomPath`): `enforcedCustomBinaryPaths` leaves it out, so every reader (launch, preflight, availability, model probe, sign-in terminal, Codex sandbox roots) resolves the base command through PATH as before #2166. The user sees it twice: `checkAgentAvailability` reports `customPathStale` and Settings → Agents shows a warning with the existing Reset beside it, and the first launch per agent and path pushes `staleAgentPath`, a warning toast with a one-click "Reset path" (`src/mainview/stale-agent-path-toast.ts`, deduped in `src/bun/stale-agent-path.ts`). Reset clears the custom path and its strict entry. A strict path that breaks still fails with the error naming the path.

## Risks
A legacy path that pointed at a wrapper (custom env, a different CLI build) now runs the plain PATH binary until the user resets or re-picks it; the toast says so at the first launch. An older build that rewrites the custom path leaves a strict entry naming the old value, so the new value is treated as legacy (lenient), which is the safe direction. Older builds drop `strictAgentCustomBinaryPaths` on their save (the settings whitelist); the path then reverts to lenient, never to bricked.

## Alternatives considered
Lenient for a missing file, strict only for one that exists but is not executable: simpler, but a path chosen yesterday that vanished would silently run another program again, which is exactly what #2166 removed. Keep it strict and only announce it once after the update: still bricks the agent until the user acts. A version stamp per path: same effect as the strict map, with a version comparison to keep correct.
