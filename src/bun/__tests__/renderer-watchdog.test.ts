import { describe, expect, it, beforeEach, vi } from "vitest";

const logged = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock("../logger", () => ({
	createLogger: () => logged,
}));

import {
	ARTIFACT_ASSOCIATION_MS,
	FORGET_MS,
	FREEZE_EVIDENCE_MS,
	MAX_HICCUPS_PER_CLIENT,
	MIN_CLIENT_AGE_MS,
	HICCUP_MS,
	LOST_MS,
	forgetRendererClient,
	recordRendererHeartbeat,
	resetRendererWatchdog,
	startRendererWatchdog,
	type FreezeEvidence,
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
	let evidence: FreezeEvidence[];
	let recoveries: number[];

	function advanceTo(ms: number) {
		clock = ms;
		tick();
	}

	/** Walk the clock forward one check at a time, the way the real timer does. */
	function runTo(ms: number) {
		for (let at = clock + CHECK_MS; at <= ms; at += CHECK_MS) advanceTo(at);
	}

	/** A window that has beaten healthily for long enough to be judged at all. */
	function settledClient(over: Partial<RendererBeat> = {}) {
		for (let at = 0; at <= MIN_CLIENT_AGE_MS + 2_000; at += 2_000) {
			clock = at;
			recordRendererHeartbeat(beat(over));
		}
	}

	beforeEach(() => {
		logged.info.mockReset();
		logged.warn.mockReset();
		resetRendererWatchdog();
		clock = 0;
		evidence = [];
		recoveries = [];
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
			onFreezeEvidence: (e) => evidence.push(e),
			onFreezeRecovered: (ms) => recoveries.push(ms),
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

	describe("artifact freeze evidence", () => {
		const ARTIFACT = { desktop: true, artifactOpen: true, artifactIdleMs: 0 };

		it("reports a desktop window that went quiet with an artifact in it", () => {
			settledClient(ARTIFACT);

			runTo(clock + FREEZE_EVIDENCE_MS - CHECK_MS);
			expect(evidence).toHaveLength(0);

			runTo(clock + CHECK_MS);
			expect(evidence).toHaveLength(1);
			expect(evidence[0]).toMatchObject({ artifactOpen: true, artifactIdleMs: 0 });
			expect(evidence[0].quietForMs).toBeGreaterThanOrEqual(FREEZE_EVIDENCE_MS);

			// One silence, one piece of evidence — not one per check.
			runTo(clock + FREEZE_EVIDENCE_MS);
			expect(evidence).toHaveLength(1);
		});

		it("counts an artifact closed moments ago, and stops counting an old one", () => {
			settledClient({ desktop: true, artifactOpen: false, artifactIdleMs: ARTIFACT_ASSOCIATION_MS - 1 });
			runTo(clock + FREEZE_EVIDENCE_MS);
			expect(evidence).toHaveLength(1);

			resetRendererWatchdog();
			evidence = [];
			stop();
			stop = startRendererWatchdog({
				now: () => clock,
				checkIntervalMs: CHECK_MS,
				setInterval: (fn) => { tick = fn; return 1; },
				clearInterval: () => {},
				onFreezeEvidence: (e) => evidence.push(e),
			});
			clock = 0;
			settledClient({ desktop: true, artifactOpen: false, artifactIdleMs: ARTIFACT_ASSOCIATION_MS + 1 });
			runTo(clock + FREEZE_EVIDENCE_MS);
			expect(evidence).toHaveLength(0);
		});

		it("says nothing about a stall with no artifact anywhere near it", () => {
			settledClient({ desktop: true, artifactOpen: false, artifactIdleMs: null });
			runTo(clock + FREEZE_EVIDENCE_MS * 2);

			expect(evidence).toHaveLength(0);
			// The ordinary lost line still gets written — only the recovery stays out.
			expect(logged.warn.mock.calls.some(([message]) => String(message).includes("heartbeat lost"))).toBe(true);
		});

		it("ignores a browser tab: its silence is also what a dropped connection looks like", () => {
			settledClient({ ...ARTIFACT, desktop: false });
			runTo(clock + FREEZE_EVIDENCE_MS * 2);
			expect(evidence).toHaveLength(0);
		});

		it("ignores a hidden window, whose timers are throttled by design", () => {
			settledClient({ ...ARTIFACT, visible: false });
			runTo(clock + FREEZE_EVIDENCE_MS * 2);
			expect(evidence).toHaveLength(0);
		});

		it("ignores a window that has only just started beating", () => {
			recordRendererHeartbeat(beat(ARTIFACT));
			runTo(FREEZE_EVIDENCE_MS * 2);
			expect(evidence).toHaveLength(0);
		});

		it("ignores a shorter stall than the evidence threshold", () => {
			settledClient(ARTIFACT);
			runTo(clock + FREEZE_EVIDENCE_MS - CHECK_MS);
			expect(evidence).toHaveLength(0);
		});

		it("judges nobody on a tick that arrived far too late — the host slept too", () => {
			settledClient(ARTIFACT);
			runTo(clock + CHECK_MS * 2);
			// One check, one enormous jump: every window looks frozen from here.
			advanceTo(clock + FREEZE_EVIDENCE_MS * 10);
			expect(evidence).toHaveLength(0);

			// And the baselines are rebased, so the very next check is not a freeze either.
			runTo(clock + FREEZE_EVIDENCE_MS - CHECK_MS);
			expect(evidence).toHaveLength(0);
		});

		it("still catches a freeze that outlived the suspend", () => {
			settledClient(ARTIFACT);
			runTo(clock + CHECK_MS * 2);
			advanceTo(clock + FREEZE_EVIDENCE_MS * 10);
			runTo(clock + FREEZE_EVIDENCE_MS);
			expect(evidence).toHaveLength(1);
		});

		it("says when the window came back, so a stall is not filed as a dead session", () => {
			settledClient(ARTIFACT);
			runTo(clock + FREEZE_EVIDENCE_MS);
			expect(evidence).toHaveLength(1);

			clock += 5_000;
			recordRendererHeartbeat(beat(ARTIFACT));
			expect(recoveries).toEqual([5_000]);
		});

		it("forgets a window that said goodbye, so closing one is not a freeze", () => {
			settledClient(ARTIFACT);
			forgetRendererClient("win-a");

			runTo(clock + FREEZE_EVIDENCE_MS * 2);
			expect(evidence).toHaveLength(0);
			expect(logged.warn).not.toHaveBeenCalled();
		});
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

		// One check at a time: a single 60s jump is what a machine waking from sleep
		// looks like, and the watchdog deliberately judges nobody on such a tick.
		runTo(LOST_MS + FORGET_MS);
		// Dropped, so a beat from a reloaded page starts clean: it reads as a brand-new
		// window ("started" again), never as a recovery of the one that went away.
		clock = LOST_MS + FORGET_MS + 1_000;
		recordRendererHeartbeat(beat());
		const messages = logged.info.mock.calls.map((call) => call[0]);
		expect(messages).toEqual(["renderer heartbeat started", "renderer heartbeat started"]);
	});
});
