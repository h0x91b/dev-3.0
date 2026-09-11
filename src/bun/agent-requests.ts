import type { AgentLaunchChoice, TaskDialogSubject } from "../shared/types";
import { createLogger } from "./logger";
import { getPushMessage } from "./rpc-handlers/shared-pure";

const log = createLogger("agent-requests");

/**
 * Agent-initiated actions that need the user's explicit go-ahead before they
 * happen. Each kind blocks the requesting CLI until the user answers in the app.
 */
export type AgentRequestKind = "complete" | "cancel" | "launch";

export interface AgentRequestDecision {
	approved: boolean;
	/** Present only for approved `launch` requests. */
	launch?: AgentLaunchChoice;
}

/**
 * What a renderer needs to draw the completion dialog, beyond the ids it already
 * gets. Kept on the pending entry so a client that arrives AFTER the original
 * push can still be handed the dialog — see {@link listPendingAgentRequests}.
 */
export interface AgentRequestDialog {
	taskTitle: string;
	subject: TaskDialogSubject;
}

interface PendingAgentRequest {
	requestId: string;
	kind: AgentRequestKind;
	taskId: string;
	projectId: string;
	decision: Promise<AgentRequestDecision>;
	resolve: (decision: AgentRequestDecision) => void;
	/** Present when the caller supplied one; absent kinds are not replayable. */
	dialog?: AgentRequestDialog;
	/** Auto-approval timer, when the request was created with a deadline. */
	autoApproveTimer?: ReturnType<typeof setTimeout>;
	/** Epoch ms the timer fires at; mirrored to the dialog for its countdown. */
	autoApproveAt: number | null;
	/** The configured delay, kept so the countdown can be re-armed on first display. */
	autoApproveMs: number;
	/** When a client first drew this dialog. Undefined until one does. */
	shownAt?: number;
	/** Set once a user touched the dialog: the request then only ever gets an explicit answer. */
	heldByUser?: boolean;
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
		/** Lets a renderer that connects later be handed this dialog. */
		dialog?: AgentRequestDialog;
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
	const entry: PendingAgentRequest = {
		requestId, kind, taskId, projectId, decision, resolve, autoApproveAt,
		autoApproveMs: autoApproveAfterMs,
		...(opts.dialog ? { dialog: opts.dialog } : {}),
	};
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
 * Restart the countdown at the moment a client first puts this request on screen.
 *
 * Dialogs are queued, not stacked, so request #2 can wait behind #1 for minutes.
 * Its timer started when it was created, so a user who thought about #1 for the
 * whole delay would find #2 already approved without ever having seen it — the
 * countdown has to measure time the user was actually given.
 *
 * Only the FIRST display re-arms it: a window that reloads and re-draws the queue
 * must not be able to postpone a launch indefinitely. And a request nobody ever
 * shows keeps its original deadline, so a closed window still cannot stall the
 * requesting agent.
 */
export function markAgentRequestShown(requestId: string): number | null {
	const entry = pendingByRequestId.get(requestId);
	if (!entry || entry.heldByUser || entry.shownAt !== undefined || !entry.autoApproveTimer || entry.autoApproveMs <= 0) {
		return entry?.autoApproveAt ?? null;
	}
	entry.shownAt = Date.now();
	clearTimeout(entry.autoApproveTimer);
	entry.autoApproveAt = Date.now() + entry.autoApproveMs;
	entry.autoApproveTimer = setTimeout(() => {
		log.info("Auto-approving agent request after timeout", {
			kind: entry.kind, taskId: entry.taskId.slice(0, 8), requestId, afterMs: entry.autoApproveMs,
		});
		resolveAgentRequest(requestId, { approved: true, launch: entry.launchChoice });
	}, entry.autoApproveMs);
	log.info("Countdown restarted when the dialog reached the screen", { requestId, autoApproveAt: entry.autoApproveAt });
	return entry.autoApproveAt;
}

/**
 * A user took this dialog over — cancel its auto-approval permanently.
 *
 * The countdown exists for an absent user; the moment somebody touches the
 * dialog it would be launching a task behind the back of the person reading it.
 * The flag outlives the timer on purpose: a re-display, a second window, or a
 * retry that joins this request must not be able to re-arm it. Only an explicit
 * Launch/Decline resolves it from here.
 *
 * Returns false for a request that is unknown or had no deadline to begin with.
 */
export function holdAgentRequestAutoApprove(requestId: string): boolean {
	const entry = pendingByRequestId.get(requestId);
	if (!entry) return false;
	const wasArmed = entry.autoApproveTimer !== undefined || entry.autoApproveAt !== null;
	entry.heldByUser = true;
	if (entry.autoApproveTimer) clearTimeout(entry.autoApproveTimer);
	entry.autoApproveTimer = undefined;
	entry.autoApproveAt = null;
	if (wasArmed) {
		log.info("Auto-approval held — the user took the dialog over", { requestId, kind: entry.kind });
		// Every client drew this dialog; the copies elsewhere must stop counting
		// down to a launch that can no longer fire on its own.
		getPushMessage()?.("agentLaunchAutoApproveHeld", { requestId });
	}
	return wasArmed;
}

/**
 * Remember the variants/priority a dialog currently shows, so an auto-approval
 * launches with the user's pick rather than the global default. Last writer wins:
 * the dialog is broadcast to every client, and only one of them can be right.
 */
export function setAgentRequestLaunchChoice(requestId: string, launch: AgentLaunchChoice): boolean {
	const entry = pendingByRequestId.get(requestId);
	if (!entry) return false;
	entry.launchChoice = launch;
	return true;
}

/**
 * Every pending request of a kind that still has nobody to answer it.
 *
 * A dialog lives only as a promise inside a renderer, and the push that created
 * it is a one-shot event. So a renderer that reloads — a remote browser tab
 * refresh is the cheap case — leaves the entry alive with no dialog behind it,
 * and because a retry JOINS instead of re-pushing, the request could never be
 * drawn again. A connecting renderer asks for this list and re-draws what it
 * finds, which is what makes the entry reachable again.
 */
export function listPendingAgentRequests(
	kind: AgentRequestKind,
): Array<{ requestId: string; taskId: string; projectId: string; dialog: AgentRequestDialog }> {
	const out: Array<{ requestId: string; taskId: string; projectId: string; dialog: AgentRequestDialog }> = [];
	for (const entry of pendingByRequestId.values()) {
		if (entry.kind !== kind || !entry.dialog) continue;
		out.push({ requestId: entry.requestId, taskId: entry.taskId, projectId: entry.projectId, dialog: entry.dialog });
	}
	return out;
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
