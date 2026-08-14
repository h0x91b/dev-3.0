/**
 * Abort signal that fires when an agent-initiated request (`complete` /
 * `launch`) is answered somewhere other than this dialog — a second window, or
 * the remote browser served by the same app. The backend broadcasts the request
 * to every connected client and pushes `agentRequestResolved` once the first
 * answer lands, so without this the losing clients keep a dead dialog on screen.
 *
 * Wire the returned `signal` into `confirm()` and, after awaiting, check
 * `signal.aborted` to skip this client's own resolution side effects — the CLI
 * already got its answer from whoever won.
 */
export function createAgentRequestAbort(requestId: string): { signal: AbortSignal; cleanup: () => void } {
	const controller = new AbortController();

	const onResolved = (e: Event) => {
		if ((e as CustomEvent).detail?.requestId === requestId) controller.abort();
	};

	window.addEventListener("rpc:agentRequestResolved", onResolved);

	return {
		signal: controller.signal,
		cleanup: () => window.removeEventListener("rpc:agentRequestResolved", onResolved),
	};
}
