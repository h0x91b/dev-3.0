# Managed omp accounts are agent dirs selected with PI_CODING_AGENT_DIR

> Partly superseded on 2026-10-17 by `decisions/2026/10/17/pi-managed-accounts-share-the-agent-dir-engine.md`: the omp-only functions became the shared agent-dir engine (`getActiveAgentDirSessionEnv`, `completeAgentDirLogin`, …), and the system login now unsets `PI_CODING_AGENT_DIR` once an omp OR pi account exists.

## Context

dev3 already runs several Claude Code and Codex logins side by side by giving each managed account its own config dir (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`). Oh My Pi (omp, `can1357/oh-my-pi`) signs in to 60+ providers itself (`/login`), and users asked for the same multi-account model there: many accounts, each signed in to whatever provider the user picks inside omp, chosen per launch.

## Investigation

Read against omp 18.11.1 (`packages/utils/src/dirs.ts`, `packages/ai/src/auth/`):

- `--profile` / `OMP_PROFILE` isolates *everything* — settings, skills, extensions, MCP, sessions. A profile would lose dev3's skills in `~/.omp/agent/skills` and the user's own `config.yml`.
- `PI_CODING_AGENT_DIR` moves the default profile's agent dir: `agent.db` (credentials) and sessions live inside it. XDG relocation is switched off when an override is set, so the location is deterministic on Linux too. Verified live with `PI_CODING_AGENT_DIR=<tmp> omp config path`.
- `omp usage accounts --json` lists the OAuth sign-ins of an agent dir as `{provider, identityKey, orgName}`. omp documents it as token-free, and it ran in 0.16 s with no network.
- Refresh is single-flighted and lease-guarded inside one `agent.db`, so several panes on one account are safe.

## Decision

- An omp account is `~/.dev3.0/agent-accounts/omp/<id>/`, passed as `PI_CODING_AGENT_DIR` (`getActiveOmpSessionEnv`, `applyOmpAccountEnv` in `src/bun/agents.ts`). Every entry of `~/.omp/agent` is symlinked in except `isPrivateOmpEntry` ones: sessions, caches and **every SQLite file**. A database opened through a link gets its `-wal` beside the link, so sharing one through a symlink corrupts it.
- Adding an account runs `omp login` (omp's own terminal counterpart of `/login`: provider picker, writes that dir's `agent.db`, exits) in the embedded sign-in terminal (`embedded-account-login-terminal`), scoped by `PI_CODING_AGENT_DIR` alone. The watch asks `omp usage accounts --json` (`completeOmpLogin`) only when the size or mtime of `agent.db`/`agent.db-wal` changed since the last empty answer, so polling does not start omp every second. dev3 never reads `agent.db` and never sees a token. Unlike Claude/Codex, no provider env key is stripped from the sign-in.
- The registry is a **new file**, `agent-accounts/omp-accounts.json`, not a key in `accounts.json`: older builds normalize that file to `claude`/`codex` and rewrite it, which would silently drop omp accounts (on-disk N-2 rule).
- Once any omp account exists, the system-login choice actively unsets `PI_CODING_AGENT_DIR`, so a value leaked into the long-lived tmux env cannot pick an account.

## Risks

- Only OAuth sign-ins are detected (`omp usage accounts` lists nothing else). `omp login` (18.11.1) is a numbered list of 84 providers that also includes API-key ones; picking one of those leaves the sign-in waiting, and the modal says so. Detecting them would need a credential listing omp does not expose without also counting the env's own keys.
- The provider list is a snapshot taken at verification. A later `/login` inside a running session shows up only after the next verification.
- If omp ever rewrites a shared file by rename, the account gets a private copy and stops following `~/.omp/agent`. This is the same exposure the Claude account dirs have.
- The manual fallback command is POSIX shell syntax, as the Codex one is. Not verified on Windows.
- dev3 stays out of the provider choice: it runs omp's own `omp login` and neither filters nor warns about any provider. What a provider permits is the user's call (background: `claude-subscription-in-third-party-harnesses`).

## Alternatives considered

- **`OMP_PROFILE` per account.** Rejected: it hides dev3's skills and the user's omp config, and puts dev3-owned state under `~/.omp`.
- **Reading `agent.db` directly.** Rejected: it is omp's internal schema and it holds the tokens. The CLI is the token-free contract.
- **Reusing a managed Codex `CODEX_HOME` login.** Rejected: two apps refreshing one rotating refresh token log each other out.
