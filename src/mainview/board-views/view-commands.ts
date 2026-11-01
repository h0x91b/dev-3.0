/**
 * The one way anything outside a board — the `v` chord, the View → Board View
 * menu, the command palette — changes the board view. The mounted `BoardHost`
 * registers a handler; a command sent while no board is on screen waits briefly
 * for the next host to mount, so "Board view: Table" from a task screen lands
 * on the board it navigates to.
 */

export type BoardViewCommand =
	| { kind: "pick"; viewId: string }
	/** The Nth offered view, 1-based, in registry order (`v 1..9`). */
	| { kind: "nth"; n: number }
	/** Back to the view this board showed before the current one (`v v`). */
	| { kind: "previous" };

/**
 * Returns false when the command cannot run yet. Only a queued command may be
 * refused: the board's views may still be registering, so it is retried on the
 * next flush until it lands or expires.
 */
type Handler = (command: BoardViewCommand, queued: boolean) => boolean;

/** Long enough for a route change to mount the board, short enough that a stale request never fires later. */
const PENDING_TTL_MS = 3000;
const ACTION_PREFIX = "view-board:";

let handler: Handler | null = null;
let pending: { command: BoardViewCommand; at: number } | null = null;

/** Called by the mounted board host. Returns the unregister function. */
export function registerBoardViewCommandHandler(next: Handler): () => void {
	handler = next;
	flushPendingBoardViewCommand();
	return () => {
		if (handler === next) handler = null;
	};
}

/** Retries a queued command; the host calls it whenever the views it offers change. */
export function flushPendingBoardViewCommand(): void {
	if (!handler || !pending) return;
	if (Date.now() - pending.at > PENDING_TTL_MS) {
		pending = null;
		return;
	}
	if (handler(pending.command, true)) pending = null;
}

/** True while a project or space board is on screen. */
export function isBoardMounted(): boolean {
	return handler !== null;
}

/** Runs the command on the board on screen, or queues it for the next board to mount. */
export function runBoardViewCommand(command: BoardViewCommand): void {
	if (handler) {
		handler(command, false);
		return;
	}
	pending = { command, at: Date.now() };
}

/** The menu / palette action string for one view, e.g. `view-board:builtin:table`. */
export function boardViewAction(viewId: string): string {
	return `${ACTION_PREFIX}${viewId}`;
}

export function parseBoardViewAction(action: string): string | null {
	return action.startsWith(ACTION_PREFIX) && action.length > ACTION_PREFIX.length ? action.slice(ACTION_PREFIX.length) : null;
}

export function resetBoardViewCommandsForTests(): void {
	handler = null;
	pending = null;
}
