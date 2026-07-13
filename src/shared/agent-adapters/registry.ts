/**
 * Agent adapter registry, keyed by the base command's last path segment
 * (reusing the llm-provider registry's key-by-command approach). An unknown /
 * custom command resolves to the explicit GenericAdapter, so every call site
 * always holds an adapter — no nullable-adapter guards.
 */
import { claudeAdapter } from "./claude";
import { codexAdapter } from "./codex";
import { cursorAdapter } from "./cursor";
import { geminiAdapter } from "./gemini";
import { genericAdapter } from "./generic";
import { opencodeAdapter } from "./opencode";
import type { AgentAdapter } from "./types";

const REGISTRY: Record<string, AgentAdapter> = {
	[claudeAdapter.command]: claudeAdapter,
	[codexAdapter.command]: codexAdapter,
	[geminiAdapter.command]: geminiAdapter,
	[cursorAdapter.command]: cursorAdapter,
	[opencodeAdapter.command]: opencodeAdapter,
};

/** Resolve a base command to its agent key (last path segment, e.g. `claude`). */
export function agentKey(baseCommand: string): string {
	return baseCommand.split("/").pop() ?? baseCommand;
}

/** The adapter for a base command; GenericAdapter for unknown/custom commands. */
export function getAgentAdapter(baseCommand: string): AgentAdapter {
	return REGISTRY[agentKey(baseCommand)] ?? genericAdapter;
}

/** Whether a base command maps to a first-class (non-generic) adapter. */
export function hasAgentAdapter(baseCommand: string): boolean {
	return agentKey(baseCommand) in REGISTRY;
}
