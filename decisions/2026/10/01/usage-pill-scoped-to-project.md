# The header usage pill follows the current project's Claude login

## Context

Once pinned logins got their own rows (`claude-usage-per-config-dir.md`), the header pill and its panel listed every pinned dir plus the default login on every screen. Inside one project only that project's login matters; the rest is noise, and the pill's headline percent could belong to another project's account.

## Decision

- `RateLimitIndicator` takes the route's `projectId` from `GlobalHeader`. `useClaudeLoginScope` (`AgentAccountIndicator.tsx`) resolves it through `getProjectClaudeLogin` into a `ClaudeLoginScope`: the pinned dir, or null when the project pins nothing or a managed Claude account overrides the pin.
- `scopeRateLimitSnapshots` (`src/shared/rate-limits.ts`) drops Claude readings outside that scope. The pill bars, headline percent and panel all read the scoped report; the panel gets only the matching pinned login and, under a pin, no default-login row (`projectPinned`).
- No project in scope (dashboard, settings) or scope still loading: every login, as before.
- Codex readings are never scoped; they have no per-project login.

## Risks

- A project with no reading yet hides the pill entirely there, unless another agent has data.
- The scope is re-resolved on panel open, so an edited pin shows in the bars only after the next open.

## Alternatives considered

- **Always show every login.** The previous behaviour; rejected by the user as noise.
- **Highlight the current project's row but keep all rows.** Still leaves the headline percent on another account.
