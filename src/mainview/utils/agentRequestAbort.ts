/**
 * Abort signal that fires when an agent-initiated request (`complete` /
 * `launch`) is answered somewhere other than this dialog — a second window, or
 * the remote browser served by the same app. The backend broadcasts the request
 * to every connected client and pushes `agentRequestResolved` once the first
 * answer lands, so without this the losing clients keep a dead dialog on screen.
 * The backend also resolves (voids) a request when its task is completed,
 * cancelled, reset or deleted by any other path.
 *
 * Wire the returned `signal` into `confirm()` and, after awaiting, check
 * `signal.aborted` to skip this client's own resolution side effects — the CLI
 * already got its answer from whoever won.
 */
const RESOLVED_MEMORY = 200;

/**
 * Requests this client already saw resolved. The on-connect replay lists a
 * request, then awaits before drawing it; a resolve that lands in that gap must
 * still keep the dialog off screen, so the signal starts out aborted for it.
 */
const resolvedRequestIds = new Set<string>();

if (typeof window !== "undefined") {
	window.addEventListener("rpc:agentRequestResolved", (e: Event) => {
		const requestId = (e as CustomEvent).detail?.requestId;
		if (typeof requestId !== "string") return;
		resolvedRequestIds.add(requestId);
		if (resolvedRequestIds.size > RESOLVED_MEMORY) {
			resolvedRequestIds.delete(resolvedRequestIds.values().next().value as string);
		}
	});
}

export function createAgentRequestAbort(requestId: string): { signal: AbortSignal; cleanup: () => void } {
	const controller = new AbortController();
	if (resolvedRequestIds.has(requestId)) controller.abort();

	const onResolved = (e: Event) => {
		if ((e as CustomEvent).detail?.requestId === requestId) controller.abort();
	};

	window.addEventListener("rpc:agentRequestResolved", onResolved);

	return {
		signal: controller.signal,
		cleanup: () => window.removeEventListener("rpc:agentRequestResolved", onResolved),
	};
}
