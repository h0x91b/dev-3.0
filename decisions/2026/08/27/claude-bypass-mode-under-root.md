# Declare IS_SANDBOX=1 for Claude launches when dev3 runs as root

## Context

On a Linux box where dev3 runs as root — a Kubernetes pod, a container image with
no unprivileged user — every Claude session died instantly. dev3 passes
`--allow-dangerously-skip-permissions` on *every* Claude launch (so the user can
toggle bypass with Shift+Tab), and that alone is enough to trip Claude Code's
root guard.

## Investigation

Read the installed `@anthropic-ai/claude-code/cli.js`. The guard is a single site
in `setup()`, and it fires on the *reachability* of bypass mode, not on its use:

```js
if (permissionMode === "bypassPermissions" || allowDangerouslySkipPermissions) {
  if (process.platform !== "win32" && process.getuid?.() === 0 &&
      process.env.IS_SANDBOX !== "1" && !CLAUDE_CODE_BUBBLEWRAP)
    console.error("--dangerously-skip-permissions cannot be used with root/sudo privileges for security reasons"),
    process.exit(1)
}
```

Three consequences: `--allow-dangerously-skip-permissions` is guarded exactly
like the hard `--dangerously-skip-permissions`; `--permission-mode
bypassPermissions` trips it with no flag at all; and the only two escapes are
`IS_SANDBOX=1` and `CLAUDE_CODE_BUBBLEWRAP`. Root itself is fine — only bypass
mode is refused.

## Decision

`claudeDefaultEnv(uid, platform)` in `src/bun/agents.ts` adds `IS_SANDBOX: "1"`
to the Claude defaults when `process.getuid() === 0` on a non-Windows platform,
and `getDefaultEnvForAgent` returns it for every Claude-family launch. Both seams
(`resolveCommandForAgent`, `resolveCommandForProject`) go through that function,
and a preset's own `envVars` are merged after the defaults, so an explicit
`IS_SANDBOX` still wins. No flag is stripped and no permission mode is rewritten.

## Risks

`IS_SANDBOX=1` is a claim about the environment, and dev3 makes it from one fact:
the process is root. A root user on a normal desktop Linux install would get the
same claim — but that user asked for a bypass preset, and the alternative is a
session that will not start.

## Alternatives considered

Strip the flags under uid 0. Rejected: to actually get Claude to boot it would
also have to rewrite `permissionMode` away from `bypassPermissions`, so a bypass
preset would silently mean something else, and an unattended agent would then sit
on permission prompts nobody is there to answer — which is worse than not
starting.
