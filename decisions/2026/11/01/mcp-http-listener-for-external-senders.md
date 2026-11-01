# MCP over HTTP on a loopback listener, for agents outside dev3

## Context

External senders (`decisions/2026/10/26/external-senders.md`) reach dev3 only through the same-user CLI socket, so an agent on another machine needs ssh plus a forced-command wrapper. Issue h0x91b/dev-3.0#2066 asked for a network API. Two records rejected MCP and an HTTP server — `cli-tool-architecture` (token cost, port conflicts, security) and `agent-vent-feedback` (no MCP surface) — but both were about agents INSIDE worktrees, which keep the CLI. This record covers clients outside dev3 only.

## Investigation

The remote-access server binds `0.0.0.0` by default and is forwarded whole by the tunnel (`cloudflare-tunnel.ts`), and its JWT has no subject or scope, so neither can carry this. dev3's Codex sandbox profile grants write on all of `DEV3_HOME` (`codex-config.ts`), so a token store there could be enrolled into by a prompt-injected task. `task.peek` is deliberately unrestricted across projects, and `message.sendAsSender` types into a live agent with no dialog — a `send` token is terminal input by another name. The all-agent usage scan behind `stats.usage` and a model-less `stats.prices` held the app's thread for ~80 s before h0x91b/dev-3.0#2150.

## Decision

`src/bun/mcp/`: stateless Streamable HTTP, JSON responses only (protocol `2025-06-18`), on its own `Bun.serve` bound to `127.0.0.1:7391`, started from both entries, never in a guest instance, off until `dev3 mcp enable`. Remote clients come through `tailscale serve --tcp` or `ssh -L`. Every request: path, then any `Origin` → 403, then the bearer (sha256 lookup; failures throttled per peer, a valid token never), then the token's sender must still be in `external-senders.json`, then a 1 MB streamed body cap. Tokens (`dev3mcp_` + 32 random bytes) live as hashes in `$XDG_CONFIG_HOME/dev3/mcp.json` (`%APPDATA%\dev3` on Windows), written only by the `dev3 mcp` CLI under a lock, 0600; the app re-reads it on inode+mtime change, fails closed on a bad file, and refuses a store inside the data root. Each token has scopes — `read` (default), `stats`, `send`, `write`, `start`, `content` — a required project allow-list, and a 90-day expiry. `tools.ts` is a fixed table over the existing socket handlers, called in process: closed input schemas, project and task resolved inside the allow-list before any handler, results in CLI `--json` terms (`{exitCode, json, error}`, codes from `src/shared/cli-errors.ts`), untrusted text marked by a per-tool `trustedFields` list. Senders act only through `*AsSender` handlers; launches and resumes never auto-approve unless the token was issued with `--auto-approve`, wait at most 20 s, and answer exit 25 while the dialog is open. `stats_get kind:usage` needs `since` or `task`, and `stats_prices` needs `models`, while #2150 is unmerged.

## Risks

A `send` or `start` token lets a tailnet peer drive an agent with a shell; mitigated by `read`-only defaults, the allow-list, expiry, per-sender revocation, the audit line per call, and a warning at issue — not eliminated. Tokens do not fix the socket's "attribution, not authentication": any unsandboxed same-user process already has every socket method. The audit trail is the 14-day diagnostic log, which Codex tasks can write, so it is diagnostics, not tamper-proof. Behind `tailscale serve` every peer is 127.0.0.1, so the auth-failure budget is shared — harmless because a valid token is never throttled. File modes are no-ops on Windows; the profile ACL applies.

## Alternatives considered

A plain JSON API on the same listener (the tool table does not depend on MCP, so only `server.ts` would change); `/mcp` on the remote server (tunnel exposure, `0.0.0.0`, the `index.html` fallthrough); reusing the remote JWT (all-powerful, no per-token revocation); the token store under `~/.dev3.0` (Codex-writable — acceptable only with an in-app confirm per token); stdio over ssh (a process per call, an OS account per host); SSE or MCP "tasks" for long calls (bounded calls plus "pending, call again" lose nothing on a dropped stream); `@modelcontextprotocol/sdk` (four methods used, not worth the dependency).

## Open questions for the maintainer (taken at the spec's defaults until answered)

1. MCP over HTTP at all, or the same listener as a plain JSON API, or neither?
2. Its own loopback listener on 7391, rather than a route on the remote server?
3. Token store outside `~/.dev3.0`, or under it with an in-app confirm for each new token?
4. Network launches never auto-approve unless the token opts in, or parity with local senders?
5. Exit 25 widened to sender launches and resumes over MCP; should the CLI's sender move/resume switch from "exit 1 timed out" to 25 too?
6. The opt-in `content` scope (terminal tail, transcript snippets) over the network: keep, or never?
