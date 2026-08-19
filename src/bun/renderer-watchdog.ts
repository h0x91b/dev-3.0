/**
 * Notice a window that stopped running JavaScript at all.
 *
 * `terminal-render-guard` already watches the ghostty render loop, but it runs
 * its own `setInterval` inside the renderer: a wedged renderer never fires it,
 * so a whole-window freeze leaves nothing in the log. The freeze on 2026-08-19
 * ~14:17 was readable only as a timing signature after the fact — renderer RPC
 * stopped mid-poll while the backend kept working for another minute.
 *
 * The backend survives that freeze, so it is the only place that can report it.
 * Each renderer beats every {@link HEARTBEAT_INTERVAL_MS}; here we say when the
 * beats stopped, what the window was doing at the time, and when they came back.
 *
 * Two failures, two lines:
 *  - **lost/resumed** — the window froze (or died) for longer than {@link LOST_MS}.
 *  - **hiccup** — the window stalled but recovered on its own; only the renderer
 *    can measure this, so each beat reports the gap it saw.
 */

import { createLogger } from "./logger";

const log = createLogger("renderer-watchdog");

export interface RendererBeat {
	/** Per page load, so several windows (and remote browsers) are judged apart. */
	clientId: string;
	/** Gap the renderer itself measured since its previous beat. */
	sinceLastBeatMs: number;
	/** A hidden window throttles timers legitimately — never called a freeze. */
	visible: boolean;
	/** The measured gap spans a hidden stretch, so throttling already explains it. */
	hiddenSinceLastBeat: boolean;
	terminals: number;
	frameErrorPanes: number;
}

/** How often each renderer is expected to beat. Keep in lockstep with the renderer. */
export const HEARTBEAT_INTERVAL_MS = 2_000;
/** Silence past this counts as a frozen (or gone) window. */
export const LOST_MS = 8_000;
/** A renderer-measured gap past this is a stall that recovered by itself. */
export const HICCUP_MS = 4_000;
export const CHECK_INTERVAL_MS = 2_000;
/** A window lost this long is closed or reloaded, not frozen — stop tracking it. */
export const FORGET_MS = 60_000;
/**
 * Hard ceiling on stall reports per window. A healthy session costs exactly one
 * line ("started"); everything else is a real symptom. A window that stalls over
 * and over has said what it has to say in a handful of lines, and the log must stay
 * readable — the point of this instrumentation is a freeze that stands out, not a
 * stream nobody scrolls through.
 */
export const MAX_HICCUPS_PER_CLIENT = 5;

interface ClientState {
	lastBeatAt: number;
	lastBeat: RendererBeat;
	lostReportedAt: number | null;
	hiccups: number;
}

export interface RendererWatchdogOptions {
	/** Extra context the backend knows and the renderer does not need to send. */
	context?: () => Record<string, string | number | boolean | null>;
	now?: () => number;
	setInterval?: (fn: () => void, ms: number) => unknown;
	clearInterval?: (handle: unknown) => void;
	checkIntervalMs?: number;
}

const clients = new Map<string, ClientState>();
let getContext: NonNullable<RendererWatchdogOptions["context"]> = () => ({});
let clock: () => number = Date.now;

export function recordRendererHeartbeat(beat: RendererBeat): void {
	const at = clock();
	const known = clients.get(beat.clientId);
	let hiccups = known?.hiccups ?? 0;

	if (!known) {
		// The one positive marker: without it, a window that never beat at all (old
		// build, broken channel) reads exactly like a healthy silent one.
		log.info("renderer heartbeat started", { client: beat.clientId, terminals: beat.terminals });
	} else if (known.lostReportedAt != null) {
		log.info("renderer heartbeat resumed", {
			client: beat.clientId,
			downMs: at - known.lastBeatAt,
			terminals: beat.terminals,
		});
	} else if (beat.sinceLastBeatMs >= HICCUP_MS && !beat.hiddenSinceLastBeat && known.hiccups < MAX_HICCUPS_PER_CLIENT) {
		hiccups = known.hiccups + 1;
		log.warn("renderer hiccup — the window stalled and recovered on its own", {
			client: beat.clientId,
			stalledMs: beat.sinceLastBeatMs,
			terminals: beat.terminals,
			frameErrorPanes: beat.frameErrorPanes,
			// Says the ceiling was hit, so silence afterwards is not read as "it stopped".
			...(hiccups === MAX_HICCUPS_PER_CLIENT ? { furtherStallsSuppressed: true } : {}),
			...getContext(),
		});
	}

	clients.set(beat.clientId, { lastBeatAt: at, lastBeat: beat, lostReportedAt: null, hiccups });
}

/** Test seam: each suite starts from an empty registry. */
export function resetRendererWatchdog(): void {
	clients.clear();
	getContext = () => ({});
	clock = Date.now;
}

export function startRendererWatchdog(opts: RendererWatchdogOptions = {}): () => void {
	clock = opts.now ?? Date.now;
	getContext = opts.context ?? (() => ({}));
	const setTimer = opts.setInterval ?? ((fn: () => void, ms: number) => setInterval(fn, ms));
	const clearTimer = opts.clearInterval ?? ((handle: unknown) => clearInterval(handle as Parameters<typeof clearInterval>[0]));

	const handle = setTimer(() => {
		const tick = clock();
		for (const [clientId, state] of clients) {
			const quietFor = tick - state.lastBeatAt;
			if (state.lostReportedAt != null) {
				if (tick - state.lostReportedAt >= FORGET_MS) clients.delete(clientId);
				continue;
			}
			// A hidden window is allowed to go quiet: the renderer beats once more on
			// its way out, so the last report is what the window could actually do.
			if (quietFor < LOST_MS || !state.lastBeat.visible) continue;
			state.lostReportedAt = tick;
			log.warn("renderer heartbeat lost — the window is frozen or gone", {
				client: clientId,
				quietForMs: quietFor,
				terminals: state.lastBeat.terminals,
				frameErrorPanes: state.lastBeat.frameErrorPanes,
				...getContext(),
			});
		}
	}, opts.checkIntervalMs ?? CHECK_INTERVAL_MS);

	return () => clearTimer(handle);
}
