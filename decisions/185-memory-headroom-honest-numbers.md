# 184 — Memory headroom: match the OS, and never flatter our own share

## Context

dev-3.0 makes it trivial to run twenty tasks at once, each with a tmux session and
an agent spawning its own children. The machine runs out of RAM, macOS starts
compressing and swapping, and because dev-3.0 is the window the user was looking
at, the conclusion is "dev-3.0 eats memory". The app process itself is a few
hundred megabytes; the tens of gigabytes belong to agent processes the user
launched, plus whatever else (Docker, a browser) was already resident. Nothing in
the product corrected that, because there was no system-wide memory surface at all.

The feature is therefore a credibility exercise as much as a UI one. Its whole
value rests on the numbers being verifiable against the user's own OS, so three
decisions below are recorded specifically because a future contributor would
otherwise "fix" them back into something more flattering and less convincing.

## Investigation

Three tools on the same 128 GB machine disagreed about memory in use:

| Source | Used | Free |
|---|---|---|
| `top` PhysMem | 126 GB | 894 MB |
| `memory_pressure` | — | "78% free" |
| Activity Monitor's definition | ~91 GB | ~37 GB |

`top` counts the reclaimable file cache as used, which is why it reports under a
gigabyte free on a machine the OS considers healthy. Activity Monitor's "Memory
Used" is App Memory + Wired + Compressed and excludes that cache.

Since Activity Monitor cannot be scripted, the formula was verified by checking
that the balance closes: `used 91.4 + cached-files 34.5 + free 1.25 ≈ 128 total`,
within 0.7% (rounding plus throttled pages). Critically,
`kern.memorystatus_vm_pressure_level` reported `1` (normal) throughout — so any
widget colouring itself from a "percent unused" threshold would have been in
permanent alarm on a machine the OS considered fine.

## Decision

Pure derivation lives in `src/bun/system-memory.ts` (parsers, pressure
classification, grouping, medians); platform I/O lives in
`src/bun/system-memory-probe.ts`. Nothing that reads computes, nothing that
computes reads — so every number is testable without mocks. The snapshot is taken
inside the existing `resource-monitor.ts` tick, from the same `ps` sample as the
per-task figures, so the app subtotal and the system total can never be from
different moments.

Three choices that must not be reverted:

1. **`used` matches Activity Monitor, not `top`** — `(anonymous − purgeable +
   wired + compressor) × pageSize` on macOS, `MemTotal − MemAvailable` on Linux.
   Reclaimable file cache counts as headroom, because the OS will hand it back.
2. **Colour comes from the OS pressure verdict**
   (`kern.memorystatus_vm_pressure_level`, Linux PSI `full avg10`), never from a
   percentage we invented. Percentage thresholds exist only in
   `classifyPressure`'s fallback branch for kernels without PSI, and that path
   flags itself as `pressureEstimated`. Active swapping escalates to at least
   `warn`, because macOS holds "normal" past the point the user feels the stall.
3. **The task subtotal is a deliberate OVERSTATEMENT** — the sum of resident
   memory across task process trees, so shared pages are counted once per
   process. It is labelled `~` with a one-line explanation in the UI. A figure
   that cannot be accused of hiding anything is the one that ends the argument.

Grouping (`deriveDisplayName`) matches the outermost `.app` bundle *before* any
attempt to split the command line, because bundle paths legitimately contain both
spaces and " - " (`/Applications/Visual Studio Code - Insiders.app/…`); splitting
first silently broke one app into two rows.

Command lines of unrelated processes are surfaced for diagnostics, fetched only
for displayed rows and capped at 400 characters.

## Risks

- **Command lines may contain credentials** and, in remote mode, travel over the
  network to a phone. Accepted knowingly for diagnostic value; mitigated only by
  capping length and sending them for displayed rows only. They carry
  `streamer-private` so screenshots mask them. Redaction is deliberately deferred.
- **The `.app` heuristic misnames a non-bundled process whose arguments mention a
  bundle** (`open /Applications/Foo.app/`). Such processes hold negligible
  memory and never reach a top-N row.
- **The tmux server itself is not attributed to dev-3.0** — it reparents to
  launchd, so it appears as an ordinary "tmux" consumer outside our share. It is
  small, and misattributing it would mean flattering ourselves in reverse.
- **`Anonymous pages` absent on older vm_stat builds** falls back to `Pages
  active`, which understates on a machine with a large inactive anonymous pool.

## Alternatives considered

- **Precise accounting** (macOS physical footprint, Linux proportional set size):
  rejected — two new platform-specific paths, and reading PSS for hundreds of
  processes every few seconds is expensive. The overstatement errs in the
  direction that does not hide the scale of agent memory.
- **Matching `top`'s used figure**: rejected — it reports 894 MB free on a healthy
  machine, which would make the widget cry wolf and train the user to ignore it.
- **One merged leaderboard** instead of two lists: rejected — with fourteen active
  tasks every row would be ours, and the comparison that gives the feature its
  point would vanish.
- **Grouping by process-tree root**: rejected — detached helpers and daemons
  reparent to init, which defeats it.
- **Hard-gating a launch under pressure**: rejected as nannying; the user retains
  authority over their own machine. See the UX decision dated 2026-07-30.
