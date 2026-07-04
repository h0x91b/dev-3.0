# 105 — Pin tmux to 3.6a via a vendored keg-only formula

## Context

tmux 3.7 (June 2026) regressed: when the server's socket is congested, clients busy-spin at 100% CPU in `client_main → imsgbuf_flush → msgbuf_write → __sendmsg` instead of waiting for writability (new OpenBSD imsg API landed upstream Nov 2024 / Jun 2025). Combined with 3.7's more expensive redraw, a busy server plus the app's pollers/RPC clients snowballs into 10–35 s UI freezes. Reproduced only with ≥2 dev-3.0 instances on one machine; bisect: 3.5a ✅, 3.6a ✅, 3.7/3.7b 🔥.

## Investigation

Verified empirically that tmux clients of one version cannot talk to a live server of another (`server exited unexpectedly` on every command) — so any version switch must survive an already-running server. Also verified that `~/.dev3.0/bin` ends up **first** in PATH inside dev3 panes (session env survives macOS `path_helper`), which makes a PATH shim reliable for agents running bare `tmux -L dev3`.

## Decision

Four coordinated pieces:

1. **Tap**: keg-only `h0x91b/dev3/tmux@3.6` formula (separate repo, h0x91b/homebrew-dev3); `release.yml` heredocs now emit `depends_on "h0x91b/dev3/tmux@3.6"` in both the cask and the CLI formula.
2. **App resolution** (`shared-pure.ts` `VENDORED_TMUX_PATHS`, `resolveBinaryPath` vendored tier): custom path → vendored keg → PATH → fallback dirs.
3. **Live-server guard** (`pty-server.ts` `selectTmuxBinary`/`probeTmuxServer`): if a running dev3 server rejects the preferred binary, fall back to a candidate that can talk to it (usually the PATH tmux that started it) until the server dies.
4. **Agent shim** (`pty-server.ts` `updateTmuxShim`): symlink `~/.dev3.0/bin/tmux` → selected binary, so agent-issued bare `tmux -L dev3` commands always match the server version.

## Risks

- Probe classifies by stderr text (`no server running` / `error connecting`); a future tmux rewording would degrade to "assume mismatch", which only costs extra probes.
- The shim lives under `~/.dev3.0/bin` next to the CLI binaries; it is never renamed, and a pre-existing non-symlink file there is left untouched.
- Keg-only dep means a fresh install has no `tmux` in the user's own PATH; the app and agents don't need it, but users poking at sockets manually must use the keg path or install their own tmux.

## Alternatives considered

- **Linking tmux@3.6 into PATH**: conflicts with an existing core tmux install; brew link behavior becomes unpredictable.
- **Blocklisting only broken versions (3.7*)**: still mixes agent clients (PATH 3.7) with an app server (3.6a), which hard-fails; the shim was needed regardless, at which point pinning is simpler and deterministic.
- **Waiting for an upstream fix**: 3.7a fixed the redraw cost (issue 5298) but the imsg busy-spin remained in 3.7b; pin now, revisit when a fixed release ships.
