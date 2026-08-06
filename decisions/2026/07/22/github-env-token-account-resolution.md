# 157 — Resolve tokens for env-backed GitHub accounts from `process.env`, not `gh auth token --user`

## Context

dev3's backend talks to GitHub through `github.ts`: it resolves the project's account (`gh auth status --json hosts`), fetches that account's token (`gh auth token --hostname H --user L`), and runs `gh` with `GH_TOKEN`/`GITHUB_TOKEN` set. Every backend GitHub feature (PR-URL resolve, PR/merge detection, PR comments, the "open PR" button) funnels through `getAccountToken`.

## Investigation

On a headless **Coder** workspace (`dev3 remote`), pasting a PR URL into New Task failed with `Couldn't resolve the pull request: Error: no oauth token found for github.com account h0x91b-wix`. Confirmed live on the box: `~/.config/gh` does not exist, `gh auth status` without an env token reports "not logged into any GitHub hosts", and `.bashrc`/`.zshrc` export `GH_TOKEN` from Coder's GitHub external-auth. So gh is authenticated **only** via the `GH_TOKEN` env var — there is no stored credential.

`gh auth status --json` still lists the account (login resolved from the env token) with `"tokenSource":"GH_TOKEN"`. But `gh auth token --hostname github.com --user <login>` has no stored credential to return; on the box's gh version it errors `no oauth token found for … account …` (on gh 2.96 it happens to fall through to the env token — the behavior is version-dependent, so `--user` cannot be relied on for env-backed accounts). dev3 surfaced gh's raw stderr verbatim.

## Decision

`github.ts` now carries each account's `tokenSource` (from `gh auth status --json`) into `GitHubAccount`. `getAccountToken` branches on it:

- **Env-backed** (`tokenSource` ∈ `{GH_TOKEN, GITHUB_TOKEN, GH_ENTERPRISE_TOKEN, GITHUB_ENTERPRISE_TOKEN}`): read the token straight from `process.env[tokenSource]`; throw a clear error if empty. Never call `gh auth token --user`.
- **Stored** (keyring / hosts.yml path): keep `gh auth token --hostname --user`, but pass the four token env vars as `""` so a stray ambient `GH_TOKEN` can't override the requested `--user` and return a different identity's token.

`getGitHubShellExports` (the "open PR in browser" script) gets the same branch — env-backed accounts export from `$GH_TOKEN` instead of the failing `gh auth token --user`.

## Risks

- Reading `process.env[tokenSource]` assumes the headless process actually inherited the env token. It does: dev3's shell-env import (`resolveShellEnv`) captures exported vars from the login shell, and `gh auth status` only reported the env-backed account because the same var was present.
- Neutralizing token env for the stored path relies on gh treating an empty `GH_TOKEN` as unset — verified against gh 2.96.

## Alternatives considered

- Fall back to reading `~/.config/gh/hosts.yml` directly — useless here (the file doesn't exist) and reaches into gh internals.
- Strip token env vars globally before every gh call — breaks the Coder box, whose only auth *is* the env token.
- Improve the error message only — leaves every backend GitHub feature broken on GH_TOKEN-only boxes.
