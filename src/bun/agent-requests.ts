import type { TaskPriority } from "../shared/types";
import { createLogger } from "./logger";
import { getPushMessage } from "./rpc-handlers/shared-pure";

const log = createLogger("agent-requests");

/**
 * Agent-initiated actions that need the user's explicit go-ahead before they
 * happen. Each kind blocks the requesting CLI until the user answers in the app.
 */
export type AgentRequestKind = "complete" | "launch";

/** The agent/config/account/priority the user picked in the launch dialog. */
export interface AgentLaunchChoice {
	agentId: string | null;
	configId: string | null;
	/** undefined → registry default; null → system login; string → that account. */
	accountId?: string | null;
	/** undefined → the request's `defaultPriority`; otherwise the user's pick. */
	priority?: TaskPriority;
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
	/** Auto-approval timer, when the request was created with a deadline. */
	autoApproveTimer?: ReturnType<typeof setTimeout>;
	/** Epoch ms the timer fires at; mirrored to the dialog for its countdown. */
	autoApproveAt: number | null;
	/** Last agent pick reported by a dialog; used when the timer fires. */
	launchChoice?: AgentLaunchChoice;
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
	opts: {
		/** Approve the request automatically after this many ms. 0/omitted ⇒ never. */
		autoApproveAfterMs?: number;
	} = {},
): { requestId: string; decision: Promise<AgentRequestDecision>; isNew: boolean; autoApproveAt: number | null } {
	const key = dedupKey(kind, taskId);
	const existingId = requestIdByKey.get(key);
	if (existingId) {
		const existing = pendingByRequestId.get(existingId);
		if (existing) {
			log.info("Joining existing agent request", { kind, taskId: taskId.slice(0, 8), requestId: existingId });
			// A retry joins the original deadline instead of extending it — otherwise
			// an agent that re-asks every few minutes would postpone the launch forever.
			return { requestId: existingId, decision: existing.decision, isNew: false, autoApproveAt: existing.autoApproveAt };
		}
	}

	const requestId = crypto.randomUUID();
	let resolve!: (decision: AgentRequestDecision) => void;
	const decision = new Promise<AgentRequestDecision>((r) => {
		resolve = r;
	});

	const autoApproveAfterMs = opts.autoApproveAfterMs ?? 0;
	const autoApproveAt = autoApproveAfterMs > 0 ? Date.now() + autoApproveAfterMs : null;
	const entry: PendingAgentRequest = { requestId, kind, taskId, projectId, decision, resolve, autoApproveAt };
	pendingByRequestId.set(requestId, entry);
	requestIdByKey.set(key, requestId);

	if (autoApproveAt !== null) {
		// The timer lives here, not in the dialog: the requesting CLI is blocked on
		// this promise, and a window that closes (or a remote browser that walks
		// away) must not leave it waiting for the full client-side timeout.
		entry.autoApproveTimer = setTimeout(() => {
			log.info("Auto-approving agent request after timeout", {
				kind, taskId: taskId.slice(0, 8), requestId, afterMs: autoApproveAfterMs,
			});
			resolveAgentRequest(requestId, { approved: true, launch: entry.launchChoice });
		}, autoApproveAfterMs);
	}

	log.info("Created agent request", { kind, taskId: taskId.slice(0, 8), requestId, autoApproveAt });
	return { requestId, decision, isNew: true, autoApproveAt };
}

/**
 * Remember the agent/config/account a dialog currently shows, so an auto-approval
 * launches with the user's pick rather than the global default. Last writer wins:
 * the dialog is broadcast to every client, and only one of them can be right.
 */
export function setAgentRequestLaunchChoice(requestId: string, launch: AgentLaunchChoice): boolean {
	const entry = pendingByRequestId.get(requestId);
	if (!entry) return false;
	entry.launchChoice = launch;
	return true;
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
	if (entry.autoApproveTimer) clearTimeout(entry.autoApproveTimer);
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
	for (const entry of pendingByRequestId.values()) {
		if (entry.autoApproveTimer) clearTimeout(entry.autoApproveTimer);
	}
	pendingByRequestId.clear();
	requestIdByKey.clear();
}
