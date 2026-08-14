import { createLogger } from "./logger";
import { getPushMessage } from "./rpc-handlers/shared-pure";

const log = createLogger("agent-requests");

/**
 * Agent-initiated actions that need the user's explicit go-ahead before they
 * happen. Each kind blocks the requesting CLI until the user answers in the app.
 */
export type AgentRequestKind = "complete" | "launch";

/** The agent/config/account the user picked in the launch dialog. */
export interface AgentLaunchChoice {
	agentId: string | null;
	configId: string | null;
	/** undefined → registry default; null → system login; string → that account. */
	accountId?: string | null;
}

export interface AgentRequestDecision {
	approved: boolean;
	/** Present only for approved `launch` requests. */
	launch?: AgentLaunchChoice;
}

interface PendingAgentRequest {
	requestId: string;
	kind: AgentRequestKind;
	taskId: string;
	projectId: string;
	decision: Promise<AgentRequestDecision>;
	resolve: (decision: AgentRequestDecision) => void;
}

const pendingByRequestId = new Map<string, PendingAgentRequest>();
const requestIdByKey = new Map<string, string>();

function dedupKey(kind: AgentRequestKind, taskId: string): string {
	return `${kind}:${taskId}`;
}

/**
 * Register (or join) a pending agent-initiated request for a task.
 * A second request of the same kind for the same task joins the existing
 * decision promise instead of spawning a duplicate dialog — agents may retry
 * after their own tool timeout while the user still has the original dialog open.
 */
export function createAgentRequest(
	kind: AgentRequestKind,
	taskId: string,
	projectId: string,
): { requestId: string; decision: Promise<AgentRequestDecision>; isNew: boolean } {
	const key = dedupKey(kind, taskId);
	const existingId = requestIdByKey.get(key);
	if (existingId) {
		const existing = pendingByRequestId.get(existingId);
		if (existing) {
			log.info("Joining existing agent request", { kind, taskId: taskId.slice(0, 8), requestId: existingId });
			return { requestId: existingId, decision: existing.decision, isNew: false };
		}
	}

	const requestId = crypto.randomUUID();
	let resolve!: (decision: AgentRequestDecision) => void;
	const decision = new Promise<AgentRequestDecision>((r) => {
		resolve = r;
	});

	const entry: PendingAgentRequest = { requestId, kind, taskId, projectId, decision, resolve };
	pendingByRequestId.set(requestId, entry);
	requestIdByKey.set(key, requestId);
	log.info("Created agent request", { kind, taskId: taskId.slice(0, 8), requestId });
	return { requestId, decision, isNew: true };
}

/** Resolve a pending request with the user's decision. Returns false if the request is unknown/expired. */
export function resolveAgentRequest(requestId: string, decision: AgentRequestDecision): boolean {
	const entry = pendingByRequestId.get(requestId);
	if (!entry) {
		log.debug("resolveAgentRequest: unknown requestId", { requestId });
		return false;
	}
	pendingByRequestId.delete(requestId);
	requestIdByKey.delete(dedupKey(entry.kind, entry.taskId));
	entry.resolve(decision);
	// The dialog was broadcast to every connected client (windows + remote
	// browsers); whoever answered first owns the decision, so tell the rest to
	// close theirs instead of leaving a dialog nobody can act on any more.
	getPushMessage()?.("agentRequestResolved", {
		requestId,
		kind: entry.kind,
		taskId: entry.taskId,
		projectId: entry.projectId,
	});
	log.info("Agent request resolved", {
		kind: entry.kind,
		taskId: entry.taskId.slice(0, 8),
		requestId,
		approved: decision.approved,
	});
	return true;
}

export function _resetAgentRequestsForTests(): void {
	pendingByRequestId.clear();
	requestIdByKey.clear();
}
