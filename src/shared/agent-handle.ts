/**
 * The address of ONE agent process inside a task: `dev3 pane list` prints it,
 * `dev3 message --agent` takes it, and a reply command carries the sender's.
 * `<pane>.<generation>.<process>[.<conversation>]`: 32-bit digests of the #1927
 * binding (pane generation token, `pid@start`, conversation id). The app checks
 * them against what runs in the task now; they tell candidates apart, they do
 * not prove identity on their own.
 */

import type { ScheduledMessageAuthor } from "./types";

export interface AgentHandle {
	paneId: string;
	paneToken: string;
	agentProcess: string;
	/** Absent when the agent's conversation id was not known. */
	sessionId: string | null;
}

/** Old #2062 handles (`a1.` + base64url): no longer accepted, so callers can say why. */
export const LEGACY_AGENT_HANDLE_PREFIX = "a1.";

const HANDLE_RE = /^(%\d+|[A-Za-z0-9_-]+)\.([0-9a-f]{8})\.([0-9a-f]{8})(?:\.([0-9a-f]{8}))?$/;

/** FNV-1a, 32 bits. Not a secret and not collision-free: see `decisions/2026/10/26/compact-agent-handles-and-sole-agent-replies.md`. */
export function agentDigest(value: string): string {
	let hash = 0x811c9dc5;
	for (const byte of new TextEncoder().encode(value)) {
		hash = Math.imul(hash ^ byte, 0x01000193);
	}
	return (hash >>> 0).toString(16).padStart(8, "0");
}

export function encodeAgentHandle(author: ScheduledMessageAuthor): string {
	const parts = [author.paneId, agentDigest(author.paneToken), agentDigest(author.agentProcess)];
	if (author.sessionId) parts.push(agentDigest(author.sessionId));
	return parts.join(".");
}

/** The digests a handle carries, or null for anything this version did not write. */
export function parseAgentHandle(handle: string): AgentHandle | null {
	const match = HANDLE_RE.exec(handle.trim());
	return match ? { paneId: match[1]!, paneToken: match[2]!, agentProcess: match[3]!, sessionId: match[4] ?? null } : null;
}

/** Is `author` the agent process `handle` was written for: same pane, pane generation and process? */
export function agentHandleNames(handle: AgentHandle, author: ScheduledMessageAuthor): boolean {
	return author.paneId === handle.paneId
		&& agentDigest(author.paneToken) === handle.paneToken
		&& agentDigest(author.agentProcess) === handle.agentProcess;
}
