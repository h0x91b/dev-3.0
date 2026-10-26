/**
 * The address of ONE agent process inside a task: `dev3 pane list` prints it,
 * `dev3 message --agent` takes it, and a reply command carries the sender's.
 * `<pane>.<generation>`: a raw pane id survives the agent it named, so the second
 * half digests the #1927 binding (pane generation, `pid@start`) and the app checks
 * it against the agent running in that pane now.
 */

import type { ScheduledMessageAuthor } from "./types";

export interface AgentHandle {
	paneId: string;
	generation: string;
}

const HANDLE_RE = /^(%\d+|[A-Za-z0-9_-]+)\.([0-9a-f]{8})$/;

/** FNV-1a, 32 bits: tells one agent generation from the next in a pane, not a secret. */
function agentGeneration(author: Pick<ScheduledMessageAuthor, "paneToken" | "agentProcess">): string {
	let hash = 0x811c9dc5;
	for (const byte of new TextEncoder().encode(`${author.paneToken}\n${author.agentProcess}`)) {
		hash = Math.imul(hash ^ byte, 0x01000193);
	}
	return (hash >>> 0).toString(16).padStart(8, "0");
}

export function encodeAgentHandle(author: ScheduledMessageAuthor): string {
	return `${author.paneId}.${agentGeneration(author)}`;
}

/** The pane and generation a handle names, or null for anything this version did not write. */
export function parseAgentHandle(handle: string): AgentHandle | null {
	const match = HANDLE_RE.exec(handle.trim());
	return match ? { paneId: match[1]!, generation: match[2]! } : null;
}

/** Is `author` the very agent process `handle` was written for? */
export function agentHandleNames(handle: AgentHandle, author: ScheduledMessageAuthor): boolean {
	return author.paneId === handle.paneId && agentGeneration(author) === handle.generation;
}
