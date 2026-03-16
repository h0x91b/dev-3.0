# 018 — Agent binary detection and pre-launch validation

## Context

When a user doesn't have an agent CLI installed (e.g., `claude`), the app spawns tmux which exits with code 127 ("command not found"). This is confusing — users think something is broken rather than simply missing.

## Decision

Reuse the existing 3-step binary resolution pattern (custom path → `which` → fallback homebrew paths) but keep agent checks separate from system requirements. Agents are optional — a missing agent should produce a friendly message, not block the app.

Key implementation points:
- `resolveBinaryPath()` extracted from `checkSystemRequirements()` in `src/bun/rpc-handlers.ts` — shared helper for both system requirements and agent checks
- `checkAgentAvailability` RPC endpoint iterates all agents, auto-saves resolved paths to `settings.agentBinaryPaths`
- `launchTaskPty()` checks if the resolved binary exists before spawning tmux; if not, it writes a retry-loop bash script that shows install instructions and waits for the user to press Enter
- Saved binary paths are used in `resolveCommandForAgent/ForProject` in `src/bun/agents.ts` to work around minimal PATH in .app bundles

## Risks

- `which` may return stale results if the user installs/uninstalls between checks. Mitigated by the "Re-check" button in UI and re-check on task launch.
- The retry script uses `command -v` which depends on the shell; bash is hardcoded so this is safe.

## Alternatives considered

- Bundling agent CLIs with the app — rejected; agents have their own auth/login flows that dev-3.0 shouldn't manage.
- Blocking task creation when agent is missing — rejected; too aggressive, the terminal error page with retry is more forgiving.
