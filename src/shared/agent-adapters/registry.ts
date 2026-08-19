/**
 * Agent adapter registry, keyed by the base command's last path segment
 * (reusing the llm-provider registry's key-by-command approach). An unknown /
 * custom command resolves to the explicit GenericAdapter, so every call site
 * always holds an adapter — no nullable-adapter guards.
 *
 * A guess by file name is only ever a default. An agent that declares its
 * `AgentFamily` overrides it, because a wrapper script, a shell alias or a
 * renamed build of Claude Code is Claude Code and must run through the very
 * same adapter.
 */
import { claudeAdapter } from "./claude";
import { codexAdapter } from "./codex";
import { cursorAdapter } from "./cursor";
import { agentKey } from "./families";
import { geminiAdapter } from "./gemini";
import { genericAdapter } from "./generic";
import { opencodeAdapter } from "./opencode";
import type { AgentFamily } from "../types";
import type { AgentAdapter } from "./types";

export { agentKey } from "./families";

const REGISTRY: Record<string, AgentAdapter> = {
	[claudeAdapter.command]: claudeAdapter,
	[codexAdapter.command]: codexAdapter,
	[geminiAdapter.command]: geminiAdapter,
	[cursorAdapter.command]: cursorAdapter,
	[opencodeAdapter.command]: opencodeAdapter,
};

/** The adapter for an agent; GenericAdapter for unknown/custom commands. */
export function getAgentAdapter(baseCommand: string, family?: AgentFamily): AgentAdapter {
	return REGISTRY[agentKey(baseCommand, family)] ?? genericAdapter;
}

/** Whether an agent maps to a first-class (non-generic) adapter. */
export function hasAgentAdapter(baseCommand: string, family?: AgentFamily): boolean {
	return agentKey(baseCommand, family) in REGISTRY;
}
