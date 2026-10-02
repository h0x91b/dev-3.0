/**
 * "Type this text into the task's terminal" - asked for by a surface that
 * holds a path the user wants to hand to the agent (the file explorer), and
 * answered by the task terminal, the only component that knows which pane has
 * focus. A task with no mounted terminal simply drops the request.
 */

const EVENT = "dev3:requestTerminalPaste";

export function requestTaskTerminalPaste(taskId: string, text: string): void {
	window.dispatchEvent(new CustomEvent(EVENT, { detail: { taskId, text } }));
}

export function subscribeTaskTerminalPaste(taskId: string, onRequest: (text: string) => void): () => void {
	const listener = (event: Event) => {
		const detail = (event as CustomEvent<{ taskId?: string; text?: string }>).detail;
		if (detail?.taskId === taskId && typeof detail.text === "string") onRequest(detail.text);
	};
	window.addEventListener(EVENT, listener);
	return () => window.removeEventListener(EVENT, listener);
}
