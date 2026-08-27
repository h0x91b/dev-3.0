# The GA4 payload: standard fields, bucketed counts, and country without an IP

## Context

The GA4 hit had grown wrong-shaped in three separate ways. `operating_system`,
`screen_resolution` and `language` were **custom user properties**, so they burned three
of GA4's twenty-five user-property slots and then rendered nothing, because a user
property is invisible until someone registers it as a custom dimension in the property's
admin — the Measurement Protocol has standard `device` fields for exactly these. Nothing
in the payload said what KIND of install was sending it (how it was installed, how many
projects it manages, how long it had been there), so the numbers could not distinguish a
day-old trial from a studio running twenty repos. And `page_location` carried the project
id and the task's seq label, minting one Page-path row per project and per task.

Geolocation had been removed a day earlier when the ipify `ip_override` lookup went
(`drop-ip-override-geolocation.md`), which left "which countries are these users in"
unanswered.

## Investigation

Three premises were checked on a real machine rather than assumed:

- **Neither `cpu_arch` NOR the OS version is derivable from the User-Agent.** The machine
  reports `arm64` on Darwin 24.6 (macOS 15.7) while WebKit's UA says
  `Intel Mac OS X 10_15_7` — Apple freezes that token, so a UA-derived version is the same
  wrong number for every Mac in the population, and Rosetta is invisible in it entirely.
  Both now come from the host: `detectRosetta()` and `osVersionFromKernel()`, the latter
  reporting the major version only because Darwin's minor does not track macOS's.
- **Install age works retroactively.** `~/.dev3.0`'s birth time is the first-launch date
  (Feb 2026 on the maintainer's machine), so the existing user base gets a real
  distribution instead of everyone reading as new on the day this ships.
- **`Intl.Locale.prototype.getTimeZones()` does not exist on node 22** and only reached
  Chrome in late 2024, so deriving country at runtime was neither portable nor testable.

## Decision

**Standard fields move out of `user_properties`.** OS, OS version, language, screen size
and category go in the Measurement Protocol's `device` object (`deviceInfo()` in
`src/mainview/analytics.ts`), and `build_commit` becomes an event parameter — it is one
distinct value per merge, which no user-scoped dimension survives.

**Nine user properties, all coarse** (`app_version`, `build_channel`, `cpu_arch`,
`install_type`, `terminal_backend`, `default_agent`, and three buckets), gathered on the
host by `collectTelemetryProfile` (`src/bun/telemetry-profile.ts`) and handed to
`initAnalytics` through the new `getTelemetryProfile` RPC. Every count is bucketed by pure
functions in `src/shared/telemetry-profile.ts` before it leaves the host: a raw count is a
near-unique fingerprint AND a dimension whose tail GA4 rolls into "(other)". Sixteen slots
stay free.

**`install_age_bucket` is a fixed grid**: `day-0`, `day-1`, `day-2`, `day-3-6`, then
`week-01`…`week-12` to a quarter, then `month-NN` forever. `day-0` is isolated
deliberately — first-day retention is the question the property exists to answer. Weeks
and months are zero-padded so a report sorted by label stays chronological inside a
family; ordering *across* the three families is not alphabetical and is not meant to be.
The install date itself is seeded from the data directory's birth time and then written to
`~/.dev3.0/install-date.json` (`src/bun/install-date.ts`), because several Linux
filesystems substitute mtime — and `~/.dev3.0` is modified constantly, so an unrecorded
age would keep collapsing to "installed today".

**Country comes from the timezone, never from an IP.** `Asia/Jerusalem` → `IL`, resolved
against a generated table (`src/shared/timezone-country.ts`, regenerate with
`scripts/generate-timezone-countries.ts`) and sent as top-level `user_location.country_id`,
which costs no user-property slot. No network call, no third party — the thing the scanners
flagged is absent by construction. City and region are deliberately left empty.

**`app_version` collapses a source build to a bare `dev`.** Every agent building from its
own worktree would otherwise mint a distinct value; the tail GA4 discards would be the
released versions. Canary keeps its version (`canary-1.48.1`), stable is unchanged. This
supersedes the `-<task>` suffix added the same day, and `BUILD_TASK_LABEL` was deleted from
`scripts/generate-build-info.ts` with it.

**`page_location` names the screen only** — `/app/project/kanban`, `/app/project/task`. See
the supersede note on `decisions/2026/07/08/ga-page-paths-use-project-id-not-name.md`.

## Risks

`device` and `user_location` are documented but may be ignored on a web stream, exactly as
`ip_override` was — that is unfalsifiable before rollout and is checked in DebugView after.
If `device` is ignored, the three fields come back as user properties at the cost of three
slots. The new properties show nothing in reports until each is registered as a custom
dimension; `app_version` deliberately avoids that dependency by being a built-in dimension.
The timezone table is a snapshot of CLDR: a zone added later resolves to no country, never
to a wrong one, and both legacy and modern spellings of every rename are covered
(`Asia/Calcutta` and `Asia/Kolkata`). Counting projects and tasks reads every board on each
launch — bounded, cached by the data layer, and each failure is swallowed individually so
analytics can never be why a launch fails.

## Alternatives considered

- **Derive the country from `Intl.Locale.getTimeZones()` at runtime.** Absent on node 22,
  new in Chrome, and a ~100 ms sweep where it does exist. Untestable in CI, which is what
  settled it.
- **Send raw project/task counts and bucket them in GA.** GA4 cannot bucket a
  user-property string, and the raw number is the identifying part.
- **Keep `update_channel` as a tenth property.** It differs from `build_channel` only when
  an update failed to land; a dedicated `update_channel_mismatch` event would cost no slot
  and was left unbuilt pending a real need.
- **Keep `build_commit` as a user property.** One value per merge — the dimension would be
  all tail.
