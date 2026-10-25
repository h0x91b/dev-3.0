export interface ClaudeSessionState {
	pid: number;
	sessionId: string;
	cwd: string;
	startedAt: number;
	status: "busy" | "idle";
	statusUpdatedAt: number;
}

/** The native interactive-session registry, verified on Claude Code 2.1.310. */
export function parseClaudeSessionState(raw: unknown): ClaudeSessionState | null {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
	const value = raw as Record<string, unknown>;
	if (value.kind !== "interactive" || value.entrypoint !== "cli") return null;
	if (value.status !== "busy" && value.status !== "idle") return null;
	if (typeof value.pid !== "number" || !Number.isSafeInteger(value.pid) || value.pid <= 0) return null;
	if (typeof value.sessionId !== "string" || !value.sessionId || typeof value.cwd !== "string" || !value.cwd) return null;
	if (typeof value.startedAt !== "number" || !Number.isFinite(value.startedAt) || value.startedAt <= 0) return null;
	if (typeof value.statusUpdatedAt !== "number" || !Number.isFinite(value.statusUpdatedAt) || value.statusUpdatedAt <= 0) return null;
	return { pid: value.pid, sessionId: value.sessionId, cwd: value.cwd, startedAt: value.startedAt, status: value.status, statusUpdatedAt: value.statusUpdatedAt };
}

export function claudeSessionBecameIdle(previous: ClaudeSessionState, next: ClaudeSessionState): boolean {
	return previous.pid === next.pid && previous.sessionId === next.sessionId
		&& previous.startedAt === next.startedAt && previous.cwd === next.cwd
		&& next.status === "idle" && next.statusUpdatedAt > previous.statusUpdatedAt;
}
