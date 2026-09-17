# The Codex `workspace` fallback profile must mirror Codex's own default

## Context

Codex refuses to load a `config.toml` that defines `[permissions.*]` profiles without a
top-level `default_permissions` (`config defines [permissions] profiles but does not set
default_permissions`). dev3 needs `[permissions.dev3]`, so `ensureCodexConfig`
(`src/bun/codex-config.ts`) invents a generic `workspace` profile and points
`default_permissions` at it whenever the user has none.

That fallback governs every Codex run on the machine, not just dev3's. It used to grant
`":minimal" = "read"`, which is narrower than what Codex does on its own: with no config at
all, Codex's filesystem sandbox is "restricted" but still has full-disk *read*. So merely
launching dev3 once silently tightened the user's standalone Codex sandbox.

## Investigation

A user reported standalone Codex TUI failing the afternoon after installing dev3:

```
failed to load AGENTS.md instructions for environment `local`: fs sandbox helper failed with
status exit status: 71: sandbox-exec: execvp() of '/opt/homebrew/bin/codex' failed: Operation
not permitted
```

Reproduced on codex-cli 0.154.0 (Homebrew cask) with `codex debug prompt-input`, and bisected
to the config: an empty config works, the same config plus `default_permissions = "workspace"`
and `[permissions.workspace.filesystem] ":minimal" = "read"` fails.

Mechanism, from the Codex source (`codex-rs/exec-server/src/fs_sandbox.rs`,
`codex-rs/sandboxing/src/seatbelt.rs`): under a non-full-read policy the AGENTS.md read runs in
a Seatbelt helper that re-execs the Codex binary. `helper_read_roots()` adds
`runtime_paths.codex_self_exe` — the unresolved `/opt/homebrew/bin/codex` symlink — as a read
root, but `build_seatbelt_access_policy()` canonicalizes read roots, so the policy allows the
Caskroom target while `sandbox-exec` execs the symlink path. An isolated `sandbox-exec` fixture
confirms Seatbelt matches the literal path handed to `execve`, not its target. This is an
upstream Codex bug (openai/codex#38286, #45953); dev3's narrowed default is what exposes it.

## Decision

**dev3-owned launches start Codex by its resolved path.** `withResolvedCodexBinary`
(`src/bun/rpc-handlers/shared-pure.ts`), applied in the launch handler (`tmux-pty.ts`, right after
the binary-existence check) replaces a leading bare `codex` token with `realpathSync` of the path
`resolveBinaryPath` already found. Grants are untouched, so dev3's sandbox posture is unchanged.
It is macOS-only (Seatbelt is what mismatches), skips a command the user shaped themselves — an
absolute path, a wrapper, any other token — skips a binary that is not a symlink, and returns the
command unchanged on any failure rather than blocking a launch. Resolution runs per launch, so a
`brew upgrade` that repoints the symlink is picked up on the next start.

It lives at the launch boundary rather than in `resolveAgentCommand` on purpose: that function is
pinned by golden command tests and runs in a vitest worker under Node, where the PATH lookup it
would need cannot run.

**The fallback profile no longer narrows Codex elsewhere.** `ensureCodexConfig` writes `":root" = "read"` for the fallback `workspace` profile
(`WORKSPACE_FALLBACK_READ_KEY`) when it creates one. It does **not** rewrite a `:minimal` grant
already present: dev3 cannot tell its own older output from a profile the user authored by hand —
the value is identical either way — and widening somebody's filesystem sandbox on that guess is
worse than leaving the narrow grant in place. `[permissions.dev3]` is unchanged; dev3's own
sessions stay narrow on purpose.

## Risks

Machines an older dev3 already narrowed stay narrow, so a Homebrew-installed Codex there keeps
failing until the user changes that key themselves or upstream fixes the exec path. That is
deliberate: the alternative silently edits user-owned permissions.

## Alternatives considered

Leaving `default_permissions` unset: Codex then refuses to load the config at all, strictly worse.
Adding the Codex binary's directory as a read root instead of `:root` (verified to work with
`"/opt/homebrew/bin" = "read"`): narrower, but it hardcodes an install layout and papers over the
upstream bug rather than removing dev3's unintended tightening. Waiting for upstream alone
(openai/codex#38286, #45953): leaves dev3's own Codex agents dead on every Homebrew install.
