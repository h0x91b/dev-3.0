/**
 * "Put the keyboard in this task's terminal" — asked for by a surface that just
 * started something the user is about to type into (the "+ Agent" dialog), and
 * answered by the task terminal, which is the only component that knows which
 * pane is focused and whether its canvas is attached yet.
 *
 * A request is a WISH, not a command: the terminal keeps it pending until a
 * focusable pane exists (a freshly spawned native pane needs a poll plus a PTY
 * URL first), then consumes it. Nothing here focuses anything itself.
 */

const EVENT = "dev3:requestTerminalFocus";

export function requestTaskTerminalFocus(taskId: string): void {
	window.dispatchEvent(new CustomEvent(EVENT, { detail: { taskId } }));
}

export function subscribeTaskTerminalFocus(taskId: string, onRequest: () => void): () => void {
	const listener = (event: Event) => {
		const detail = (event as CustomEvent<{ taskId: string }>).detail;
		if (detail?.taskId === taskId) onRequest();
	};
	window.addEventListener(EVENT, listener);
	return () => window.removeEventListener(EVENT, listener);
}
