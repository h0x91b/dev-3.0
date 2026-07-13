/**
 * AgentAdapter seam — barrel. See ./types.ts for the interface and decision 124
 * for the design. Adding a coding agent = add one adapter file and register it.
 */
export type {
	AgentAdapter,
	AdapterLaunchOptions,
	CodexLaunchRuntime,
	HooksSpec,
	TrustKind,
	TemplateContext,
} from "./types";
export { getAgentAdapter, hasAgentAdapter, agentKey } from "./registry";
export { shellEscape, quoteIfUnsafe } from "./shell";
export { interpolateTemplate, buildTaskPrompt } from "./template";
export { claudeAdapter } from "./claude";
export { codexAdapter } from "./codex";
export { geminiAdapter } from "./gemini";
export { cursorAdapter } from "./cursor";
export { opencodeAdapter } from "./opencode";
export { genericAdapter } from "./generic";
