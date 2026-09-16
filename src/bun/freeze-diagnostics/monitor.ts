import type { FreezeBeat, FreezeMessage } from "./protocol";

interface WindowState {
	focused: boolean;
	lastBeatAt: number | null;
	createdAt: number;
	beat: FreezeBeat | null;
}

export const HOST_SILENCE_MS = 5_000;
export const RENDERER_SILENCE_MS = 10_000;
export const OBSERVER_GRACE_MS = 20_000;
const CAPTURE_COOLDOWN_MS = 5 * 60_000;
const MAX_CAPTURES = 3;

export function createFreezeMonitor(startedAt: number) {
	let lastHostAt = startedAt;
	let lastTickAt = startedAt;
	let graceUntil = startedAt + OBSERVER_GRACE_MS;
	let lastCaptureAt = -Infinity;
	let captures = 0;
	const windows = new Map<number, WindowState>();
	const history: Array<{ at: number; event: string; windowId?: number }> = [];
	const event = (at: number, name: string, windowId?: number) => {
		history.push({ at, event: name, ...(windowId === undefined ? {} : { windowId }) });
		if (history.length > 60) history.shift();
	};

	function receive(message: FreezeMessage, at: number) {
		if (message.kind === "host") { lastHostAt = at; return; }
		if (message.kind === "display") { event(at, `display-${message.reason}`); return; }
		if (message.kind === "stop") return;
		const id = message.windowId;
		if (message.kind === "window" && message.event === "closed") {
			windows.delete(id);
			event(at, "closed", id);
			return;
		}
		const state = windows.get(id) ?? { focused: false, lastBeatAt: null, createdAt: at, beat: null };
		if (message.kind === "beat") {
			if (state.beat?.visible !== message.beat.visible || state.beat?.clientId !== message.beat.clientId) {
				event(at, message.beat.visible ? "renderer-visible" : "renderer-hidden", id);
			}
			state.lastBeatAt = at;
			state.beat = message.beat;
		} else {
			state.focused = message.event === "focus" || (message.event === "created" && state.focused);
			event(at, message.event, id);
		}
		// Remote callers never enter this registry; bound even a broken desktop window loop.
		if (windows.has(id) || windows.size < 16) windows.set(id, state);
	}

	function snapshot(at: number) {
		return {
			at, hostAgeMs: at - lastHostAt, graceUntil, captures,
			windows: [...windows].map(([windowId, state]) => ({
				windowId, nativeFocused: state.focused,
				beatAgeMs: state.lastBeatAt === null ? null : at - state.lastBeatAt,
				lastBeat: state.beat,
			})),
			history: [...history],
		};
	}

	function check(at: number) {
		const observerGapMs = at - lastTickAt;
		lastTickAt = at;
		if (observerGapMs > HOST_SILENCE_MS || observerGapMs < 0) {
			graceUntil = at + OBSERVER_GRACE_MS;
			event(at, "observer-gap-sleep-or-scheduling-unknown");
			return { observerGapMs, capture: null };
		}
		const reasons: string[] = [];
		if (at - lastHostAt >= HOST_SILENCE_MS) reasons.push("host-heartbeat-missing");
		for (const [id, state] of windows) {
			if (!state.focused && !state.beat?.visible) continue;
			if (at - (state.lastBeatAt ?? state.createdAt) >= RENDERER_SILENCE_MS) {
				reasons.push(`window-${id}-heartbeat-missing`);
			} else if (state.beat?.visible && (state.beat.animationFrameAgeMs ?? 0) >= RENDERER_SILENCE_MS) {
				reasons.push(`window-${id}-animation-frame-missing`);
			}
		}
		if (!reasons.length || at < graceUntil || at - lastCaptureAt < CAPTURE_COOLDOWN_MS || captures >= MAX_CAPTURES) {
			return { observerGapMs: null, capture: null };
		}
		lastCaptureAt = at;
		captures++;
		return { observerGapMs: null, capture: { reasons, ...snapshot(at) } };
	}

	return { receive, check, snapshot };
}
