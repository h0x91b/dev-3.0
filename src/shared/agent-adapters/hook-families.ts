/**
 * Which agent CLIs dev3 knows, and which of them have lifecycle hooks — as data,
 * deliberately free of adapter imports.
 *
 * The renderer needs both facts to disclose what "Auto" resolves to and to warn
 * that an unrecognized command gets no hooks; importing the adapter registry for
 * that would bundle every agent's skill body (~32 KB) into the app. Drift is
 * impossible in practice: `__tests__/hook-families.test.ts` asserts this file
 * against the real REGISTRY and every adapter's `hooksSpec()`.
 */
import type { AgentHooksIntegration } from "../types";

/** Every agent command with a first-class adapter (i.e. not the generic fallback). */
export const KNOWN_AGENT_COMMANDS: readonly string[] = ["claude", "codex", "gemini", "agent", "opencode"];

/** Agent commands that install lifecycle hooks, and which family they install. */
const HOOK_FAMILY: Record<string, AgentHooksIntegration> = { claude: "claude", codex: "codex" };

/** The command's own key: its last path segment (mirrors `agentKey`). */
function commandKey(baseCommand: string): string {
	return baseCommand.split("/").pop() ?? baseCommand;
}

/** The hook family a base command resolves to on its own — what "Auto" means. */
export function autoHooksFamily(baseCommand: string): AgentHooksIntegration {
	return HOOK_FAMILY[commandKey(baseCommand)] ?? "none";
}

/** Whether dev3 recognizes this command as one of its supported agent CLIs. */
export function isKnownAgentCommand(baseCommand: string): boolean {
	return KNOWN_AGENT_COMMANDS.includes(commandKey(baseCommand));
}
