import { describe, expect, it, beforeEach, vi } from "vitest";

const logged = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock("../logger", () => ({
	createLogger: () => logged,
}));

import {
	FORGET_MS,
	MAX_HICCUPS_PER_CLIENT,
	HICCUP_MS,
	LOST_MS,
	recordRendererHeartbeat,
	resetRendererWatchdog,
	startRendererWatchdog,
	type RendererBeat,
} from "../renderer-watchdog";

/**
 * The freeze this exists for (2026-08-19 ~14:17) left no cause in the log — only a
 * timing signature. These lock the signature down: the backend must say a window
 * went quiet, must not say it about a window that is merely hidden, and must not
 * confuse one window with another.
 */

const CHECK_MS = 1_000;

function beat(over: Partial<RendererBeat> = {}): RendererBeat {
	return {
		clientId: "win-a",
		sinceLastBeatMs: 2_000,
		visible: true,
		hiddenSinceLastBeat: false,
		terminals: 3,
		frameErrorPanes: 0,
		...over,
	};
}

describe("renderer watchdog", () => {
	let clock = 0;
	let tick: () => void;
	let stop: () => void;

	function advanceTo(ms: number) {
		clock = ms;
		tick();
	}

	beforeEach(() => {
		logged.info.mockReset();
		logged.warn.mockReset();
		resetRendererWatchdog();
		clock = 0;
		stop?.();
		stop = startRendererWatchdog({
			now: () => clock,
			checkIntervalMs: CHECK_MS,
			setInterval: (fn) => {
				tick = fn;
				return 1;
			},
			clearInterval: () => {},
			context: () => ({ activeTask: "abcd1234" }),
		});
	});

	it("marks the first beat of a window, so a silent log can be told from a broken channel", () => {
		recordRendererHeartbeat(beat({ terminals: 2 }));
		expect(logged.info).toHaveBeenCalledTimes(1);
		expect(logged.info.mock.calls[0][0]).toContain("heartbeat started");
		expect(logged.info.mock.calls[0][1]).toMatchObject({ client: "win-a", terminals: 2 });

		clock = 2_000;
		recordRendererHeartbeat(beat());
		expect(logged.info).toHaveBeenCalledTimes(1);
	});

	it("stays silent while the beats keep coming", () => {
		for (let at = 0; at < LOST_MS * 3; at += 2_000) {
			clock = at;
			recordRendererHeartbeat(beat());
			advanceTo(at + 500);
		}
		expect(logged.warn).not.toHaveBeenCalled();
	});

	it("reports a visible window that went quiet, once, with what it was doing", () => {
		recordRendererHeartbeat(beat({ terminals: 4, frameErrorPanes: 2 }));

		advanceTo(LOST_MS - 1);
		expect(logged.warn).not.toHaveBeenCalled();

		advanceTo(LOST_MS);
		expect(logged.warn).toHaveBeenCalledTimes(1);
		const [message, extra] = logged.warn.mock.calls[0];
		expect(message).toContain("heartbeat lost");
		expect(extra).toMatchObject({ client: "win-a", quietForMs: LOST_MS, terminals: 4, frameErrorPanes: 2, activeTask: "abcd1234" });

		advanceTo(LOST_MS * 2);
		expect(logged.warn).toHaveBeenCalledTimes(1);
	});

	it("says nothing about a hidden window — its timers are throttled by design", () => {
		recordRendererHeartbeat(beat({ visible: false }));
		advanceTo(LOST_MS * 4);
		expect(logged.warn).not.toHaveBeenCalled();
	});

	it("reports the recovery with how long the window was gone", () => {
		recordRendererHeartbeat(beat());
		advanceTo(LOST_MS);
		expect(logged.warn).toHaveBeenCalledTimes(1);

		clock = 30_000;
		recordRendererHeartbeat(beat({ sinceLastBeatMs: 30_000 }));
		// info #1 was the "started" marker for this window's first beat.
		expect(logged.info).toHaveBeenCalledTimes(2);
		const [message, extra] = logged.info.mock.calls[1];
		expect(message).toContain("resumed");
		expect(extra).toMatchObject({ client: "win-a", downMs: 30_000 });
		// The recovery is not also a hiccup — one event, one line.
		expect(logged.warn).toHaveBeenCalledTimes(1);
	});

	it("reports a stall the window measured itself and recovered from", () => {
		recordRendererHeartbeat(beat());
		clock = HICCUP_MS;
		recordRendererHeartbeat(beat({ sinceLastBeatMs: HICCUP_MS }));

		expect(logged.warn).toHaveBeenCalledTimes(1);
		const [message, extra] = logged.warn.mock.calls[0];
		expect(message).toContain("hiccup");
		expect(extra).toMatchObject({ client: "win-a", stalledMs: HICCUP_MS, activeTask: "abcd1234" });
	});

	it("does not call a gap a stall when the window was hidden across it", () => {
		recordRendererHeartbeat(beat());
		clock = 120_000;
		// Coming back from hidden: a full minute of throttled timers, not a freeze.
		recordRendererHeartbeat(beat({ sinceLastBeatMs: 118_000, visible: true, hiddenSinceLastBeat: true }));
		expect(logged.warn).not.toHaveBeenCalled();
	});

	it("never floods the log: stalls stop being reported after the ceiling", () => {
		recordRendererHeartbeat(beat());
		for (let n = 1; n <= MAX_HICCUPS_PER_CLIENT + 20; n += 1) {
			clock += HICCUP_MS;
			recordRendererHeartbeat(beat({ sinceLastBeatMs: HICCUP_MS }));
		}

		expect(logged.warn).toHaveBeenCalledTimes(MAX_HICCUPS_PER_CLIENT);
		// The last line admits it is the last one.
		const last = logged.warn.mock.calls[MAX_HICCUPS_PER_CLIENT - 1][1];
		expect(last).toMatchObject({ furtherStallsSuppressed: true });
	});

	it("judges each window on its own — a live one does not cover a frozen one", () => {
		recordRendererHeartbeat(beat({ clientId: "frozen" }));
		recordRendererHeartbeat(beat({ clientId: "alive" }));

		for (let at = 2_000; at <= LOST_MS + 2_000; at += 2_000) {
			clock = at;
			recordRendererHeartbeat(beat({ clientId: "alive" }));
			advanceTo(at + 100);
		}

		expect(logged.warn).toHaveBeenCalledTimes(1);
		expect(logged.warn.mock.calls[0][1]).toMatchObject({ client: "frozen" });
	});

	it("forgets a window that never came back, instead of tracking it forever", () => {
		recordRendererHeartbeat(beat());
		advanceTo(LOST_MS);
		expect(logged.warn).toHaveBeenCalledTimes(1);

		advanceTo(LOST_MS + FORGET_MS);
		// Dropped, so a beat from a reloaded page starts clean: it reads as a brand-new
		// window ("started" again), never as a recovery of the one that went away.
		clock = LOST_MS + FORGET_MS + 1_000;
		recordRendererHeartbeat(beat());
		const messages = logged.info.mock.calls.map((call) => call[0]);
		expect(messages).toEqual(["renderer heartbeat started", "renderer heartbeat started"]);
	});
});
