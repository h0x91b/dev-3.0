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
	/**
	 * A desktop window, not a remote browser tab. A tab's silence is also what a
	 * dropped network looks like, so only desktop silence is used as freeze
	 * evidence — a browser tab still gets the log lines.
	 */
	desktop?: boolean;
	/** An HTML artifact viewer was mounted. Coarse presence only — no document, no title. */
	artifactOpen?: boolean;
	/** Age of the last artifact open/close in this page load; null = none at all. */
	artifactIdleMs?: number | null;
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

/**
 * Silence past this, from a visible desktop window that had an artifact in it, is
 * what the popup recovery acts on. Far past {@link LOST_MS} on purpose: eight
 * seconds is enough to write a log line about, nowhere near enough to change a
 * user's settings over.
 */
export const FREEZE_EVIDENCE_MS = 20_000;
/** An artifact closed this recently still counts as "the window was doing artifacts". */
export const ARTIFACT_ASSOCIATION_MS = 60_000;
/** Beats a window must land before its silence is allowed to mean anything. */
export const MIN_HEALTHY_BEATS = 3;
/** And for this long — a window still booting is allowed to stutter. */
export const MIN_CLIENT_AGE_MS = 15_000;
/**
 * A check that runs this many intervals late means the host was not running
 * either — machine asleep, process starved. Nobody's silence is judged on such a
 * tick, because every window looks frozen from the far side of a suspend.
 */
export const SUSPEND_TICK_FACTOR = 3;

interface ClientState {
	lastBeatAt: number;
	firstBeatAt: number;
	beats: number;
	lastBeat: RendererBeat;
	lostReportedAt: number | null;
	/** Freeze evidence already written for this silence — one per silence. */
	evidenceAt: number | null;
	hiccups: number;
}

export interface FreezeEvidence {
	at: number;
	quietForMs: number;
	artifactOpen: boolean;
	artifactIdleMs: number | null;
}

export interface RendererWatchdogOptions {
	/** Extra context the backend knows and the renderer does not need to send. */
	context?: () => Record<string, string | number | boolean | null>;
	now?: () => number;
	setInterval?: (fn: () => void, ms: number) => unknown;
	clearInterval?: (handle: unknown) => void;
	checkIntervalMs?: number;
	/** A visible desktop window went quiet with an artifact in it. */
	onFreezeEvidence?: (evidence: FreezeEvidence) => void;
	/** That same window came back — the freeze was a stall. */
	onFreezeRecovered?: (afterMs: number) => void;
}

const clients = new Map<string, ClientState>();
let getContext: NonNullable<RendererWatchdogOptions["context"]> = () => ({});
let clock: () => number = Date.now;
let onEvidence: (evidence: FreezeEvidence) => void = () => {};
let onRecovered: (afterMs: number) => void = () => {};

/** Was this window doing artifacts when it went quiet? */
function artifactAssociated(beat: RendererBeat): boolean {
	if (beat.artifactOpen === true) return true;
	return typeof beat.artifactIdleMs === "number" && beat.artifactIdleMs <= ARTIFACT_ASSOCIATION_MS;
}

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

	if (known?.evidenceAt != null) {
		// Freeze evidence exists for this window and the window is back: say so, so
		// the next startup can tell a stall that ended from a session that never did.
		try {
			onRecovered(at - known.evidenceAt);
		} catch {
			/* diagnostics only */
		}
	}

	clients.set(beat.clientId, {
		lastBeatAt: at,
		firstBeatAt: known?.firstBeatAt ?? at,
		beats: (known?.beats ?? 0) + 1,
		lastBeat: beat,
		lostReportedAt: null,
		evidenceAt: null,
		hiccups,
	});
}

/**
 * A window said goodbye (closed, reloaded, navigated away). Without this its
 * silence is indistinguishable from a freeze, and closing a window would look
 * like the very symptom we recover from.
 */
export function forgetRendererClient(clientId: string): void {
	if (clients.delete(clientId)) log.info("renderer heartbeat stopped", { client: clientId });
}

/** Test seam: each suite starts from an empty registry. */
export function resetRendererWatchdog(): void {
	clients.clear();
	getContext = () => ({});
	clock = Date.now;
	onEvidence = () => {};
	onRecovered = () => {};
}

export function startRendererWatchdog(opts: RendererWatchdogOptions = {}): () => void {
	clock = opts.now ?? Date.now;
	getContext = opts.context ?? (() => ({}));
	onEvidence = opts.onFreezeEvidence ?? (() => {});
	onRecovered = opts.onFreezeRecovered ?? (() => {});
	const setTimer = opts.setInterval ?? ((fn: () => void, ms: number) => setInterval(fn, ms));
	const clearTimer = opts.clearInterval ?? ((handle: unknown) => clearInterval(handle as Parameters<typeof clearInterval>[0]));
	const checkIntervalMs = opts.checkIntervalMs ?? CHECK_INTERVAL_MS;
	let lastTickAt: number | null = null;

	const handle = setTimer(() => {
		const tick = clock();
		const sinceLastTick = lastTickAt == null ? 0 : tick - lastTickAt;
		lastTickAt = tick;
		if (sinceLastTick > checkIntervalMs * SUSPEND_TICK_FACTOR) {
			// The host slept (or was starved) through that gap, so every window looks
			// frozen and none of them is. Rebase the baselines and judge nobody: a
			// freeze that really outlived the suspend is reported on the next tick.
			log.info("watchdog tick arrived late — treating it as a host suspend, not a freeze", { gapMs: sinceLastTick });
			for (const state of clients.values()) state.lastBeatAt = tick;
			return;
		}
		for (const [clientId, state] of clients) {
			const quietFor = tick - state.lastBeatAt;
			// Evidence is judged before the forget/lost bookkeeping, because it needs a
			// longer silence than the log line does and must survive it being reported.
			if (
				state.evidenceAt == null &&
				quietFor >= FREEZE_EVIDENCE_MS &&
				state.lastBeat.visible &&
				state.lastBeat.desktop === true &&
				state.beats >= MIN_HEALTHY_BEATS &&
				state.lastBeatAt - state.firstBeatAt >= MIN_CLIENT_AGE_MS &&
				artifactAssociated(state.lastBeat)
			) {
				state.evidenceAt = tick;
				try {
					onEvidence({
						at: tick,
						quietForMs: quietFor,
						artifactOpen: state.lastBeat.artifactOpen === true,
						artifactIdleMs: state.lastBeat.artifactIdleMs ?? null,
					});
				} catch (err) {
					log.warn("failed to record freeze evidence", { error: String(err) });
				}
			}
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
				artifactOpen: state.lastBeat.artifactOpen === true,
				...getContext(),
			});
		}
	}, checkIntervalMs);

	return () => clearTimer(handle);
}
