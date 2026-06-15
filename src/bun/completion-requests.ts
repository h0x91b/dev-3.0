import { createLogger } from "./logger";

const log = createLogger("completion-requests");

interface PendingCompletionRequest {
	requestId: string;
	taskId: string;
	projectId: string;
	decision: Promise<boolean>;
	resolve: (approved: boolean) => void;
}

const pendingByRequestId = new Map<string, PendingCompletionRequest>();
const requestIdByTaskId = new Map<string, string>();

/**
 * Register (or join) a pending agent-initiated completion request for a task.
 * A second request for the same task joins the existing decision promise
 * instead of spawning a duplicate dialog — agents may retry after their own
 * tool timeout while the user still has the original dialog open.
 */
export function createCompletionRequest(
	taskId: string,
	projectId: string,
): { requestId: string; decision: Promise<boolean>; isNew: boolean } {
	const existingId = requestIdByTaskId.get(taskId);
	if (existingId) {
		const existing = pendingByRequestId.get(existingId);
		if (existing) {
			log.info("Joining existing completion request", { taskId: taskId.slice(0, 8), requestId: existingId });
			return { requestId: existingId, decision: existing.decision, isNew: false };
		}
	}

	const requestId = crypto.randomUUID();
	let resolve!: (approved: boolean) => void;
	const decision = new Promise<boolean>((r) => {
		resolve = r;
	});

	const entry: PendingCompletionRequest = { requestId, taskId, projectId, decision, resolve };
	pendingByRequestId.set(requestId, entry);
	requestIdByTaskId.set(taskId, requestId);
	log.info("Created completion request", { taskId: taskId.slice(0, 8), requestId });
	return { requestId, decision, isNew: true };
}

/** Resolve a pending request with the user's decision. Returns false if the request is unknown/expired. */
export function resolveCompletionRequest(requestId: string, approved: boolean): boolean {
	const entry = pendingByRequestId.get(requestId);
	if (!entry) {
		log.debug("resolveCompletionRequest: unknown requestId", { requestId });
		return false;
	}
	pendingByRequestId.delete(requestId);
	requestIdByTaskId.delete(entry.taskId);
	entry.resolve(approved);
	log.info("Completion request resolved", { taskId: entry.taskId.slice(0, 8), requestId, approved });
	return true;
}

export function _resetCompletionRequestsForTests(): void {
	pendingByRequestId.clear();
	requestIdByTaskId.clear();
}
