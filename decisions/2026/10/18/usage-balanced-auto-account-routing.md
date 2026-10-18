# Usage-balanced "Auto" account routing

## Context

Every launch nobody hand-picked an account for landed on the registry default,
however exhausted that account's limits were (`resolveAccountIdOverride`,
`src/bun/agent-accounts.ts`). `per-launch-agent-account-selection` deferred
"auto-distribute" to this task. PR #1853 (design only, unmerged) proposed a
consumption policy, with an owner taxonomy, routes that switch harness, and a
"5h resets soon" first tier. The user ruled differently:
- route only subscription logins and never fall back to API spend;
- make every login available by default, with per-project exclusions;
- never switch harness or model;
- prefer the less-used short window, and only when short windows are
  comparable prefer the weekly quota that expires soonest while respecting
  its remaining capacity.

## Decision

`accountId: "auto"` (`AUTO_ACCOUNT_ID`) is a launch-time choice. The pure
router `routeAccount` (`src/shared/account-routing.ts`) works in three steps:

- **Hard filters.** These drop:
  - metered logins (Claude API profiles, `*usage_based*` plans, spend limits);
  - project exclusions;
  - duplicate identities;
  - limit-less readings;
  - a short window at ≥ 90% (back at ≤ 85%);
  - less than 5pp of weekly headroom (back at ≥ 8pp).
- **Band.** It keeps every account within 10pp of the lowest effective short window.
- **Pick.** It takes the highest `pace = weekly headroom ÷ share of the weekly
  window left` (capped at 4, ties within 0.15 go to the lower short window).

Windows are classified by their real `windowMinutes`, so Codex's primary is never
assumed to be 5h.

"Effective" usage is pessimistic and computed the same way every time:
- the measured % is a floor;
- a reading older than 10 minutes drifts up by 10pp/h, capped at 25;
- a passed reset counts as 10%;
- each launch reserves 6pp/1pp, which decays linearly over 20 minutes.

Unlimited logins are an overflow tier, and never-read logins are used only once
no known login is below 60%.

`src/bun/account-router.ts` holds the reservations and hysteresis in memory.
Pick and reserve are one synchronous step, so a burst of launches spreads.

Routing runs only on fresh launches, through `CommandOptions.autoRouting`,
inside `resolveLaunchAccount` (`src/bun/agents.ts`). The launch paths that
build it are:
- `launchTaskPty` when not resuming;
- the column agent;
- `+ Agent`;
- bug hunters.

A preset that pins `CLAUDE_CONFIG_DIR` / `CODEX_HOME` bypasses routing, and so
does a project pinning its Claude login, which falls back to the default.

The pick is persisted on the pane, and on the task as `accountId` +
`accountPick`. Resume, restart and reconnect therefore never route again. Every
fresh pane now records the account it really used, which also stops Claude/omp
resumes drifting with the default.

Settings and UI:
- Default = Auto is `GlobalSettings.autoAccountDefault`, not the registry, so older
  builds still read a valid specific default.
- Exclusions are `Project.autoAccountExclusions`, stored in `projects.json` only.
- When nothing is eligible, `spawnVariants` turns the launch into a "Start in…"
  at the earliest reset, still `"auto"`, and raises an attention badge.

## Risks

- Readings are only as fresh as dev3's own sessions. An idle Claude login never
  refreshes, and usage outside dev3 is visible only at its next reading.
- The 6pp per-launch cost is an uncalibrated guess.
- A single launch started straight into an in-progress column (not via
  `spawnVariants`) fails with an error instead of deferring.
- An older build firing a scheduled launch that still carries `"auto"` treats it
  as an unknown account id, which means no env and the system login.
- Rotating personal subscriptions purely around limits may breach a provider's
  terms. This is balancing the user's own logins, never limit evasion.

## Alternatives considered

- **A two-stage band followed by "soonest weekly reset".** Rejected because it
  ignores headroom and burns a nearly-spent week early.
- **One continuous score `(1−s)² × pace`.** Rejected because it trades away a
  20pp short-window gap for weekly pressure, against the user's rule.
- **#1853's owner model and harness routes.** Overridden by the user's decisions.
- **Mid-task switching on a limit hit.** Explicitly out of scope.
- **Probing idle accounts.** Deferred to calibration.
