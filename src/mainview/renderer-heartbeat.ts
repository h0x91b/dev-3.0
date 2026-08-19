import { api } from "./rpc";
import { session } from "./terminal-session-stats";

/**
 * Beat into the backend log so a frozen window leaves a record.
 *
 * Nothing inside a wedged renderer can report on itself — every timer, guard and
 * error handler here is dead with it. The backend keeps running, so it is the one
 * that names the freeze; this only has to keep saying "still alive" and carry the
 * two numbers the backend cannot see (the gap this page measured, and how much
 * terminal was on screen). Verdicts live in `bun/renderer-watchdog.ts`.
 */

/** Keep in lockstep with HEARTBEAT_INTERVAL_MS in bun/renderer-watchdog.ts. */
const INTERVAL_MS = 2_000;

/** Per page load: several windows and remote browsers beat into one backend. */
function newClientId(): string {
	return Math.random().toString(36).slice(2, 10);
}

export function startRendererHeartbeat(clientId = newClientId()): () => void {
	let lastBeatAt = Date.now();
	// A hidden window has its timers throttled to about one tick a minute, so a gap
	// spanning a hidden stretch is not a stall. Only this page can tell the two
	// apart — the backend just sees a big number.
	let hiddenSinceLastBeat = document.visibilityState !== "visible";

	function beat() {
		const at = Date.now();
		const sinceLastBeatMs = at - lastBeatAt;
		lastBeatAt = at;
		const hidden = hiddenSinceLastBeat || document.visibilityState !== "visible";
		hiddenSinceLastBeat = document.visibilityState !== "visible";
		try {
			void api.request
				.rendererHeartbeat({
					clientId,
					sinceLastBeatMs,
					visible: document.visibilityState === "visible",
					hiddenSinceLastBeat: hidden,
					terminals: session.liveTerminals,
					frameErrorPanes: session.frameErrorPanes,
				})
				?.catch(() => {});
		} catch {
			/* diagnostics only — never break the app */
		}
	}

	const timer = setInterval(beat, INTERVAL_MS);
	// A window on its way to hidden beats once more, so the backend's last report
	// says "hidden" and its silence is read as throttling instead of a freeze.
	function onVisibilityChange() {
		hiddenSinceLastBeat = true;
		beat();
	}
	document.addEventListener("visibilitychange", onVisibilityChange);
	beat();

	return () => {
		clearInterval(timer);
		document.removeEventListener("visibilitychange", onVisibilityChange);
	};
}
