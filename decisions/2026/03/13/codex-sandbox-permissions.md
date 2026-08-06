# 016 — Codex sandbox permission profiles and environment fixes

## Context

Codex (OpenAI's CLI agent) runs tool calls inside a macOS seatbelt sandbox. dev3 needs Codex agents to communicate with the dev3 desktop app via Unix sockets under `~/.dev3.0/sockets/<pid>.sock` and to read/write data files under `~/.dev3.0/`. Earlier versions patched `~/.codex/config.toml` with a flat `[permissions.network]` section — that syntax stopped working in newer Codex versions (post-0.114).

## Investigation

### 1. Codex permission profile system (two separate systems)

Codex has **two independent profile systems** that use confusingly similar syntax:

- **Permission profiles** — `[permissions.X.filesystem]`, `[permissions.X.network]` — selected via `default_permissions = "X"` or `-c 'default_permissions="X"'`
- **Config profiles** — `[profiles.X]` — selected via `-p X`, sets model/sandbox/search preferences

These are NOT the same. `-p dev3` selects `[profiles.dev3]`, while `-c 'default_permissions="dev3"'` selects `[permissions.dev3]`.

### 2. `--full-auto` breaks permission profiles

`--full-auto` is a shortcut for `-a on-request --sandbox workspace-write`. The `--sandbox workspace-write` part triggers Codex's **legacy sandbox path** which bypasses the permission profile system entirely. So even if you have a perfect `[permissions.dev3]` config, using `--full-auto` means it's never read.

**Fix**: non-bypass presets use `-a on-request` (just the approval part) instead of `--full-auto`, letting the permission profile drive sandbox behavior.

### 3. Sandbox rewrites HOME=/tmp

Inside Codex's seatbelt sandbox, `HOME` is set to `/tmp`. This breaks dev3 CLI context detection because:
- `WORKTREES_DIR` is derived from `HOME` at module load time
- `HOME=/tmp` → `WORKTREES_DIR=/tmp/.dev3.0/worktrees`
- Real `cwd` is `/Users/arsenyp/.dev3.0/worktrees/...`
- Path prefix match fails → "not inside a dev3 worktree"

**Fix**: fall back to searching for `/.dev3.0/worktrees/` marker directly in the cwd path and derive the real dev3 home from there.

### 4. Tilde paths don't resolve in sandbox

Permission entries like `"~/.dev3.0" = "write"` may not work because the sandbox has `HOME=/tmp`, so `~` resolves to `/tmp` not the real home.

**Fix**: all paths in `[permissions.dev3.filesystem]` use absolute paths derived from `worktreesPath` (e.g., `/Users/arsenyp/.dev3.0` instead of `~/.dev3.0`).

### 5. macOS seatbelt blocks homebrew zsh

Codex's seatbelt sandbox blocks `/opt/homebrew/bin/zsh` when running tool calls. If the user's `$SHELL` points to homebrew zsh, tool execution fails with `sandbox-exec: execvp() of '/opt/homebrew/bin/zsh' failed: Operation not permitted`.

**Attempted fix**: injecting `SHELL=/bin/bash` into the launch environment — this does NOT work because Codex's tool runner uses its own shell detection mechanism, not `$SHELL`.

**Working workaround**: the agent itself must set `shell="/bin/bash"` and `login=false` in its `exec_command` calls. This is communicated via the dev3 skill — both in the skill description (frontmatter, read before the body is loaded) and in the skill body. The hint is also added to `~/.agents/AGENTS.md`.

### 6. `allow_unix_sockets` uses directory-level matching on macOS

The seatbelt rules use `subpath` for Unix socket allowance. So `allow_unix_sockets = ["/Users/arsenyp/.dev3.0/sockets"]` allows all PID-based sockets under that directory without needing to know specific PIDs.

### 7. Config changes require a fresh Codex session

Codex reads `config.toml` once at startup. The managed network proxy is created with a static reloader (`codex-rs/core/src/config/network_proxy_spec.rs`). Changing the config mid-session has no effect — always restart Codex after config changes.

## Decision

### Config patching (`src/bun/codex-config.ts`)

We create an **isolated dev3 permission profile** that doesn't touch the user's existing config:

```toml
[permissions.dev3.filesystem]
":minimal" = "read"
"/Users/arsenyp/.codex/skills" = "read"
"/Users/arsenyp/.agents/skills" = "read"
"/Users/arsenyp/.dev3.0" = "write"

[permissions.dev3.filesystem.":project_roots"]
"." = "write"

[permissions.dev3.network]
enabled = true
allow_unix_sockets = ["/Users/arsenyp/.dev3.0/sockets"]

[profiles.dev3]
web_search = "live"
```

The patching logic:
- Creates `[permissions.dev3]` if missing, patches individual entries if partially present
- Creates `[profiles.dev3]` if missing
- Adds `[projects."<worktreesPath>"]` trust entry
- Cleans up legacy `[permissions.network]` sections (only if they contain dev3 socket paths)
- Does NOT modify `default_permissions` or `[permissions.workspace.*]`

### Preset CLI flags (`src/shared/types.ts`)

Non-bypass presets: `-p dev3 -a on-request --no-alt-screen -c 'default_permissions="dev3"' -c 'model_reasoning_effort="..."'`
Bypass presets: `-p dev3 -a on-request --no-alt-screen --sandbox danger-full-access -c 'model_reasoning_effort="..."'`

Note: bypass presets use `-a on-request` (auto-approve) explicitly instead of `--full-auto`, because `--full-auto` implies `--sandbox workspace-write` which would conflict with the explicit `--sandbox danger-full-access`. Bypass presets skip `-c 'default_permissions="dev3"'` (permission profile) because `--sandbox danger-full-access` overrides permissions anyway.

### CLI context detection (`src/cli/context.ts`)

Two-strategy approach:
1. Try HOME-based `WORKTREES_DIR` prefix match (fast path)
2. Fall back to `/.dev3.0/worktrees/` marker search in cwd (sandbox fallback)

The fallback derives `realDev3Home` from the marker position and uses it for all file reads.

## Risks

- **Absolute paths are user-specific**: the config is patched with the current user's home path. If the home directory changes (unlikely), the permission entries become stale. The patching runs on every app startup, so it would self-heal.
- **`:minimal` semantics may change**: we rely on Codex's `:minimal` filesystem scope. If Codex changes what `:minimal` includes, our permissions may need adjustment.
- **`/bin/bash` availability**: we assume `/bin/bash` exists on all macOS systems. This is true for all supported macOS versions.

## Alternatives considered

1. **Modify user's `[permissions.workspace]` directly** — rejected because it's intrusive and could break the user's own Codex config.
2. **Use `~` (tilde) paths** — rejected because sandbox sets HOME=/tmp, so `~` resolves incorrectly.
3. **Keep `--full-auto` and just add network permissions** — rejected because `--full-auto` triggers the legacy sandbox path that bypasses permission profiles entirely.
4. **Set HOME in Codex env** — rejected because the sandbox forcibly overwrites HOME at the process level, not from the env.

---
# Suggested bug report about zsh

## Title
macOS seatbelt selects user default shell from pw_shell but may fail to exec Homebrew zsh because /opt/homebrew/bin is not in the runtime allowlist

## Summary
On macOS, Codex prefers the user’s login shell from pw_shell for shell tool execution. If the user’s default shell is Homebrew zsh at /opt/homebrew/bin/
zsh, sandboxed shell tool calls can fail before the command runs with:

sandbox-exec: execvp() of '/opt/homebrew/bin/zsh' failed: Operation not permitted

This happens because shell selection prefers the user shell path, but the seatbelt runtime allowlist only includes system executable directories like /
bin and /usr/bin, not /opt/homebrew/bin.

Expected
If the user’s default shell lives outside the seatbelt runtime allowlist, Codex should fall back to an allowed system shell such as /bin/zsh, /bin/bash,
or /bin/sh instead of failing before command execution.

Actual
Codex selects /opt/homebrew/bin/zsh and attempts to execute it inside seatbelt. The process can fail at execvp() before the shell command starts.

Code pointers

- user shell discovery: codex-rs/core/src/shell.rs:92
- prefers user shell path when it exists: codex-rs/core/src/shell.rs:178
- default shell selection on macOS: codex-rs/core/src/shell.rs:292
- shell argv construction: codex-rs/core/src/shell.rs:43
- seatbelt wrapping: codex-rs/core/src/sandboxing/mod.rs:647
- runtime allowlist only includes system bins: codex-rs/core/src/restricted_read_only_platform_defaults.sbpl:159

Minimal reproduce

1. On macOS, set the user login shell to Homebrew zsh:

chsh -s /opt/homebrew/bin/zsh

2. Start a fresh sandboxed Codex session without bypass flags.
3. Trigger any shell tool call that uses the default shell, for example a simple pwd or echo hello.
4. Observe that the command may fail before execution with:

sandbox-exec: execvp() of '/opt/homebrew/bin/zsh' failed: Operation not permitted

Suggested fix
Before using the discovered user shell path under macOS seatbelt, check whether it lives in an allowed executable runtime directory. If not, fall back to
an allowed system shell (/bin/zsh, /bin/bash, /bin/sh) and optionally emit a warning.

Why this fix is better than widening the allowlist
It preserves the tighter security posture of the current seatbelt policy and avoids broadly allowing arbitrary Homebrew executables under /opt/homebrew/
bin.
