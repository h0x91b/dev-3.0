import { claudeHookPaneId } from "./claude-prompt";

/**
 * What the prompt ledger needs from a Claude tool hook payload: the session, the tool,
 * the call id (absent on PermissionRequest), the subagent that raised it, and the pane
 * the prompt shows in. Empty when the payload is unreadable.
 */
export function claudeToolHookFields(rawInput: string, env: NodeJS.ProcessEnv): Record<string, string> {
	let payload: Record<string, unknown>;
	try {
		payload = JSON.parse(rawInput) as Record<string, unknown>;
	} catch {
		return {};
	}
	const fields: Record<string, string> = {};
	const pick = (key: string, field: string) => {
		const value = payload[key];
		if (typeof value === "string" && value) fields[field] = value;
	};
	pick("session_id", "sessionId");
	pick("tool_name", "toolName");
	pick("tool_use_id", "toolUseId");
	pick("agent_id", "agentId");
	const paneId = claudeHookPaneId(env);
	if (paneId) fields.paneId = paneId;
	return fields;
}
