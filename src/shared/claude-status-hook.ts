export const CLAUDE_TOOL_STATUS_EVENTS = ["PreToolUse", "PostToolUse", "PostToolUseFailure", "SubagentStop", "TeammateIdle", "PermissionRequest", "Notification"] as const;
export type ClaudeToolStatusEvent = typeof CLAUDE_TOOL_STATUS_EVENTS[number];

export interface ClaudeHookOwner {
	sessionId?: string;
	agentId?: string;
}

export interface ClaudeToolStatus extends ClaudeHookOwner {
	event: ClaudeToolStatusEvent;
}

/** Malformed hooks cannot establish ownership, so they must not move task status. */
export function parseClaudeToolStatus(raw: string): ClaudeToolStatus | null {
	try {
		const value = JSON.parse(raw);
		if (!value || typeof value !== "object" || Array.isArray(value)) return null;
		if (!CLAUDE_TOOL_STATUS_EVENTS.includes(value.hook_event_name)) return null;
		if (value.agent_id !== undefined && typeof value.agent_id !== "string") return null;
		if (value.session_id !== undefined && typeof value.session_id !== "string") return null;
		if (["SubagentStop", "TeammateIdle"].includes(value.hook_event_name) && !value.agent_id) return null;
		if (value.hook_event_name === "Notification" && !["permission_prompt", "elicitation_dialog"].includes(value.notification_type)) return null;
		return {
			event: value.hook_event_name,
			...(typeof value.session_id === "string" && value.session_id ? { sessionId: value.session_id } : {}),
			...(typeof value.agent_id === "string" && value.agent_id ? { agentId: value.agent_id } : {}),
		};
	} catch { return null; }
}
