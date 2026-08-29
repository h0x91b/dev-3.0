import type { ConversationFidelity, ConversationSource } from "./conversation-model";
import type { AgentPromptDelivery } from "./agent-prompt-delivery";

/**
 * What crosses the RPC boundary when one task's conversation is handed to a
 * different agent. The retelling itself never does — it is written to a file and
 * the new agent is pointed at it (`src/bun/conversation-handoff.ts`).
 */

/** The conversation a handoff would retell, as the picker needs to describe it. */
export interface HandoffPreview {
	source: ConversationSource;
	sessionId: string | null;
	turns: number;
	toolCalls: number;
	fidelity: ConversationFidelity["level"];
}

/** What actually happened to the retelling after the new agent's pane opened. */
export interface HandoffOutcome {
	path: string;
	chars: number;
	source: ConversationSource;
	delivery: AgentPromptDelivery;
}

export interface SpawnAgentResult {
	/** Null when the spawn was an ordinary extra agent, with nothing handed over. */
	handoff: HandoffOutcome | null;
}
