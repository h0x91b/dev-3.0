/**
 * Which agent CLIs dev3 knows — as data, deliberately free of adapter imports.
 *
 * The renderer needs these facts to disclose what "Auto" resolves to and to warn
 * that an unrecognized command is handled as an unknown CLI; importing the
 * adapter registry for that would bundle every agent's skill body (~32 KB) into
 * the app. Drift is impossible in practice: `__tests__/agent-adapters.test.ts`
 * asserts this file against the real REGISTRY.
 */
import type { AgentFamily } from "../types";

/** Every agent command with a first-class adapter (i.e. not the generic fallback). */
export const KNOWN_AGENT_COMMANDS: readonly AgentFamily[] = ["claude", "codex", "gemini", "agent", "opencode"];

/** The families a user can declare, in the order the settings editor offers them. */
export const SELECTABLE_AGENT_FAMILIES: readonly AgentFamily[] = [...KNOWN_AGENT_COMMANDS, "none"];

/** The command's own key: its last path segment. */
function commandKey(baseCommand: string): string {
	return baseCommand.split("/").pop() ?? baseCommand;
}

/**
 * Resolve an agent to its registry key (e.g. `claude`). A declared family wins
 * outright — that declaration is the user telling dev3 what the binary is, and
 * `"none"` deliberately keys nothing so the GenericAdapter answers. Without one,
 * fall back to the command's last path segment.
 *
 * Lives here rather than in `registry.ts` so the renderer and `llm-provider.ts`
 * can key on an agent without importing the adapters (and their skill bodies).
 */
export function agentKey(baseCommand: string, family?: AgentFamily): string {
	if (family) return family === "none" ? "" : family;
	return commandKey(baseCommand);
}

/** The family a base command resolves to on its own — what "Auto" means. */
export function autoAgentFamily(baseCommand: string): AgentFamily {
	const key = commandKey(baseCommand) as AgentFamily;
	return KNOWN_AGENT_COMMANDS.includes(key) ? key : "none";
}

/** Whether dev3 recognizes this command as one of its supported agent CLIs. */
export function isKnownAgentCommand(baseCommand: string): boolean {
	return KNOWN_AGENT_COMMANDS.includes(commandKey(baseCommand) as AgentFamily);
}
