# Pin the amd64 apt mirror off azure, and bound the apt step

## Context

On 2026-08-19 the canary channel published nothing for over two hours. `build-linux-x64` in
`release-build-linux.yml` hung on a bare `sudo apt-get update` for 27, 45 and then 64 minutes
across three consecutive runs (32229071683, 32231773146, 32235140398). Each log ends identically:
`azure.archive.ubuntu.com` answers `Ign:` on all five channels, apt fails over to
`https://archive.ubuntu.com`, fetches the three `InRelease` files — then emits nothing at all until
the run is cancelled. No error, no timeout, no partial progress.

`canary-publish.yml` serialises publishes through `concurrency: canary-publish` with
`cancel-in-progress: false`, so one stalled Linux runner holds the group. Every later tick queued
and was then cancelled, which is what made a single hung job look like a dead channel.

## Investigation

Two probes, and the first one was wrong. Probe 32242999970 ran on a real `ubuntu-22.04` runner,
dumped the image's apt config and timed six mirrors. The image uses `deb
mirror+file:/etc/apt/apt-mirrors.txt`, listing `azure.archive.ubuntu.com` (priority 1),
`archive.ubuntu.com` (2), `security.ubuntu.com` (3) — the failover seen in the hung logs. Every
candidate answered 200; azure led the raw fetch (4.5 MB in 0.03 s) and the independent
`mirrors.edge.kernel.org` was the slowest real `apt-get update` at 30 s against azure's 17 s. Read
alone, that says no mirror switch helps and the problem is runner egress.

It landed in a healthy window. Run 32243397119, on the same code minutes later, stalled again and
this time ran to completion, which is what produced the real numbers: azure was *alive* there
(`Hit`/`Get`, not `Ign`) and served all 42 packages at **58.3 kB/s** — `apt-get update` 27.4 MB in
2 min 31 s, `apt-get install` 54.1 MB in 15 min 27 s, job green at 20 min 48 s. So azure fails two
ways on amd64: dead, or alive and crawling. Both trace to the same host.

Probe 32245652275 then ran a character-identical copy of the new step on both architectures.
Pinned to `https://archive.ubuntu.com`, amd64 did `apt-get update` in **4 s** and `apt-get install`
in **9 s** — against the same day's 2 min 31 s and 15 min 27 s on azure. arm64 correctly skipped
the rewrite and was healthy throughout (3 s, 9 s).

## Decision

Pin first, bound second, in `.github/workflows/release-build-linux.yml`:

1. On amd64 only, rewrite `/etc/apt/apt-mirrors.txt` to `https://archive.ubuntu.com` +
   `https://security.ubuntu.com`, dropping azure. Guarded on `dpkg --print-architecture`, not
   `inputs.arch`, so the guard cannot drift from the runner it runs on.
2. Wrap each apt call in `timeout` (300 s per `update` attempt, three attempts, 900 s for
   `install`), pass `Acquire::Retries=3` and 20 s HTTP/HTTPS timeouts, and fail with `::error::`
   if all three update attempts stall. `timeout-minutes: 35` is a backstop, not the mechanism.

Budgets are sized off the worst *successful* run, not a healthy probe: the first cut used
180 s/480 s and would have failed run 32243397119, which needed 151 s and 927 s and shipped. The
retry loop was verified under `bash -e` against a stubbed apt in all three paths (clean,
stalls-twice-then-recovers, stalls-three-times); the first stub was itself broken and passed the
three-stall case falsely, which is how it was caught.

`build.yml`'s conditional `Ensure tmux` step, the only other apt caller in the repo, gets a
10-minute step bound for the same reason.

Separately, and at Arseny's request, the canary cron moved from `3,23,43 * * * *` to
`0,30 * * * *`: at 20-minute spacing a publish routinely met its own next tick even when healthy.

## Risks

arm64 is deliberately left on the shipped list, including azure — it was healthy throughout and it
is **not verified** that `archive.ubuntu.com` serves arm64 at all, so pinning there would be
unverified risk with no upside. If azure degrades on arm64 later, this fix does not cover it.

`archive.ubuntu.com` is Canonical's origin rather than a CDN edge, so it is plausibly slower than a
healthy azure and is a single point of failure with only `security.ubuntu.com` behind it — the
retry loop and the 35-minute bound are what stop that from becoming another silent hour. Round
half-hour cron times also land in the busiest scheduling slot, so ticks fire later than the old
offset ones did.

## Alternatives considered

**A third-party mirror** (`mirrors.edge.kernel.org`, `mirror.enzu.com`, `us.archive.ubuntu.com`).
Rejected on probe 32242999970: kernel.org was the slowest of six on a real `apt-get update`, and
none beat `archive.ubuntu.com`.

**Retries alone, no pin.** What the first probe's reading implied. Rejected once run 32243397119
showed azure itself serving at 58.3 kB/s: a retry on the same runner keeps the same mirror, so it
bounds the damage without removing the cause.

**Cache the .debs, or a prebuilt container with the GTK/WebKit deps baked in.** The structural fix
and immune to mirror weather, but a much larger change to the release pipeline; `17e04f1fa` already
removed a Linux dependency cache here as net-negative on the cache budget.

**Do nothing and dispatch by hand when mirrors recover.** Leaves the hour-long queue hold for the
next outage.
