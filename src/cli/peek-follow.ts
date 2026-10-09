import { isCaptureUnsupported, type TaskPeekSnapshot } from "../shared/task-peek";

/** `--interval` bounds in seconds: fast enough to watch a build, slow enough not to hammer the app. */
export const PEEK_FOLLOW_DEFAULT_INTERVAL_S = 30;
export const PEEK_FOLLOW_MIN_INTERVAL_S = 1;
export const PEEK_FOLLOW_MAX_INTERVAL_S = 3600;

export interface PeekFollowDeps {
	fetchSnapshot: () => Promise<TaskPeekSnapshot>;
	emit: (snapshot: TaskPeekSnapshot) => void;
	/** Resolves after `ms`, or early once `signal` aborts. */
	sleep: (ms: number, signal: AbortSignal) => Promise<void>;
	now: () => number;
}

export type PeekFollowEnd = "stopped" | "unsupported";

/**
 * What "the screen changed" means: the tail text and why it is missing. Pane
 * ages and `observedAt` move on every sample, so they are deliberately left out —
 * otherwise an idle pane would re-emit every interval.
 */
export function peekFollowSignature(snapshot: TaskPeekSnapshot): string {
	return JSON.stringify([
		snapshot.sessionPresent,
		snapshot.unavailable,
		snapshot.tail ? [snapshot.tail.paneId, snapshot.tail.text] : null,
	]);
}

/**
 * Sampled follow (issue #1926): emit the current snapshot at once, then sample once
 * per interval and emit only when the signature differs from the last EMITTED one.
 * Sampling on a fixed clock is what coalesces — everything a pane redraws between
 * two samples collapses into the one latest screen, and output never wakes us early.
 * A backend that publishes no screen ends the follow after the first snapshot.
 */
export async function runPeekFollow(deps: PeekFollowDeps, intervalMs: number, signal: AbortSignal): Promise<PeekFollowEnd> {
	let sampledAt = deps.now();
	const first = await deps.fetchSnapshot();
	if (signal.aborted) return "stopped";
	deps.emit(first);
	if (first.unavailable && isCaptureUnsupported(first.unavailable)) return "unsupported";

	let lastEmitted = peekFollowSignature(first);
	while (!signal.aborted) {
		// Measured from the previous sample's START, so a slow read never lets two samples bunch up.
		await deps.sleep(Math.max(0, sampledAt + intervalMs - deps.now()), signal);
		if (signal.aborted) break;
		sampledAt = deps.now();
		const snapshot = await deps.fetchSnapshot();
		if (signal.aborted) break;
		const signature = peekFollowSignature(snapshot);
		if (signature !== lastEmitted) {
			deps.emit(snapshot);
			lastEmitted = signature;
		}
	}
	return "stopped";
}

/** Timer-backed sleep that a Ctrl-C cuts short, leaving no pending timer behind. */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal.aborted) return resolve();
		const done = () => {
			clearTimeout(timer);
			signal.removeEventListener("abort", done);
			resolve();
		};
		const timer = setTimeout(done, ms);
		signal.addEventListener("abort", done, { once: true });
	});
}
