import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../logger", () => ({
	createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import {
	agentAcceptsTypedInput,
	agentReadiness,
	forgetAgentPaneLaunch,
	forgetAgentReadiness,
	noteAgentLaunching,
	noteAgentSessionAlive,
	noteAgentSessionEnded,
	resetAgentReadinessForTests,
	waitForAgentReadiness,
} from "../agent-readiness";

const CLAUDE = { reportsLifecycle: true, primary: true } as const;
const EXTRA = { reportsLifecycle: true, primary: false } as const;

beforeEach(() => resetAgentReadinessForTests());

describe("agentReadiness", () => {
	it("knows nothing about a task nobody launched in this run", () => {
		expect(agentReadiness("t1")).toBe("unknown");
		expect(agentAcceptsTypedInput("t1")).toBe(true);
	});

	it("blocks a launched agent until it reports in", () => {
		const launch = noteAgentLaunching("t1", CLAUDE);
		expect(agentReadiness("t1")).toBe("booting");
		expect(agentAcceptsTypedInput("t1")).toBe(false);

		noteAgentSessionAlive("t1", { sessionId: "sess-a", launchId: launch });
		expect(agentReadiness("t1")).toBe("ready");
		expect(agentAcceptsTypedInput("t1")).toBe(true);
	});

	// A harness with no lifecycle hooks would sit in `booting` forever and every
	// message to it would be refused — worse than the bug the gate exists to fix.
	it("stays open for a harness that reports no lifecycle", () => {
		expect(noteAgentLaunching("t1", { reportsLifecycle: false, primary: true })).toBeNull();
		expect(agentReadiness("t1")).toBe("unknown");
		expect(agentAcceptsTypedInput("t1")).toBe(true);
	});

	it("reports gone once every session that opened has closed", () => {
		const launch = noteAgentLaunching("t1", CLAUDE);
		noteAgentSessionAlive("t1", { sessionId: "sess-a", launchId: launch });
		noteAgentSessionEnded("t1", { sessionId: "sess-a", launchId: launch });
		expect(agentReadiness("t1")).toBe("gone");
		expect(agentAcceptsTypedInput("t1")).toBe(false);
	});

	it("stays ready while another agent session is still open", () => {
		const launch = noteAgentLaunching("t1", CLAUDE);
		noteAgentSessionAlive("t1", { sessionId: "sess-a", launchId: launch });
		noteAgentSessionAlive("t1", { sessionId: "sess-b", launchId: launch });
		noteAgentSessionEnded("t1", { sessionId: "sess-a", launchId: launch });
		expect(agentReadiness("t1")).toBe("ready");
	});

	it("ignores an end for a session it never saw start", () => {
		const launch = noteAgentLaunching("t1", CLAUDE);
		noteAgentSessionAlive("t1", { sessionId: "sess-a", launchId: launch });
		noteAgentSessionEnded("t1", { sessionId: "sess-zzz", launchId: launch });
		expect(agentReadiness("t1")).toBe("ready");
	});

	it("pairs a start and end that carry no session id", () => {
		const launch = noteAgentLaunching("t1", CLAUDE);
		noteAgentSessionAlive("t1", { launchId: launch });
		noteAgentSessionAlive("t1", { sessionId: "   ", launchId: launch });
		expect(agentReadiness("t1")).toBe("ready");
		noteAgentSessionEnded("t1", { launchId: launch });
		expect(agentReadiness("t1")).toBe("gone");
	});

	it("accepts a receipt for a task it never saw launch", () => {
		noteAgentSessionAlive("t9", { sessionId: "sess-a" });
		expect(agentReadiness("t9")).toBe("ready");
	});

	it("forgets a task on teardown", () => {
		noteAgentLaunching("t1", CLAUDE);
		forgetAgentReadiness("t1");
		expect(agentReadiness("t1")).toBe("unknown");
	});

	it("keeps tasks apart", () => {
		noteAgentLaunching("t1", CLAUDE);
		const second = noteAgentLaunching("t2", CLAUDE);
		noteAgentSessionAlive("t2", { sessionId: "sess-b", launchId: second });
		expect(agentReadiness("t1")).toBe("booting");
		expect(agentReadiness("t2")).toBe("ready");
	});
});

// Clearing a map is not a generation token: the process it belonged to is still
// running, and its hook simply arrives afterwards and looks new.
describe("generation token", () => {
	it("rejects a receipt from the launch this one replaced", () => {
		const first = noteAgentLaunching("t1", CLAUDE);
		const second = noteAgentLaunching("t1", CLAUDE);
		expect(first).not.toBe(second);

		// The old agent's hook finally reaches dev3, after the relaunch.
		expect(noteAgentSessionAlive("t1", { sessionId: "old", launchId: first })).toBe(false);
		expect(agentReadiness("t1")).toBe("booting");

		expect(noteAgentSessionAlive("t1", { sessionId: "new", launchId: second })).toBe(true);
		expect(agentReadiness("t1")).toBe("ready");
	});

	it("refuses a superseded launch's SessionEnd as well", () => {
		const first = noteAgentLaunching("t1", CLAUDE);
		noteAgentSessionAlive("t1", { sessionId: "s", launchId: first });
		const second = noteAgentLaunching("t1", CLAUDE);
		noteAgentSessionAlive("t1", { sessionId: "s2", launchId: second });

		expect(noteAgentSessionEnded("t1", { sessionId: "s2", launchId: first })).toBe(false);
		expect(agentReadiness("t1")).toBe("ready");
	});

	// An older dev3 build's pane, a resumed session, or an agent the user started
	// by hand carries no token. It counts — but only once no launch is outstanding,
	// so it can never stand in for the generation dev3 is actually waiting on.
	it("accepts a tokenless receipt only when no launch is outstanding", () => {
		noteAgentLaunching("t1", CLAUDE);
		expect(noteAgentSessionAlive("t1", { sessionId: "sess-a" })).toBe(false);

		forgetAgentReadiness("t1");
		expect(noteAgentSessionAlive("t1", { sessionId: "sess-a" })).toBe(true);
		expect(agentReadiness("t1")).toBe("ready");
	});

	// An extra pane joins the era rather than replacing it, so the main agent's
	// receipt is not thrown away when a hunter pane spawns.
	it("keeps the primary receipt when an extra pane launches", () => {
		const primary = noteAgentLaunching("t1", CLAUDE);
		noteAgentSessionAlive("t1", { sessionId: "main", paneId: "%1", launchId: primary });
		const extra = noteAgentLaunching("t1", EXTRA);

		expect(agentReadiness("t1", "%1")).toBe("ready");
		noteAgentSessionAlive("t1", { sessionId: "hunter", paneId: "%2", launchId: extra });
		expect(agentReadiness("t1")).toBe("ready");
	});
});

// One pane's verdict may never authorize another: a second pane can be mid-launch
// while the first is long past its trust prompt.
describe("mixed-readiness panes", () => {
	it("refuses a pane that is still booting while a sibling is ready", () => {
		const primary = noteAgentLaunching("t1", CLAUDE);
		noteAgentSessionAlive("t1", { sessionId: "main", paneId: "%1", launchId: primary });
		const extra = noteAgentLaunching("t1", { ...EXTRA, paneId: "%2" });

		expect(agentReadiness("t1", "%1")).toBe("ready");
		expect(agentReadiness("t1", "%2")).toBe("booting");
		expect(agentAcceptsTypedInput("t1", "%2")).toBe(false);

		noteAgentSessionAlive("t1", { sessionId: "hunter", paneId: "%2", launchId: extra });
		expect(agentReadiness("t1", "%2")).toBe("ready");
	});

	// A send that resolves its own pane inside the backend could land in either
	// pane, so an unproved destination is refused while anything is booting.
	it("refuses an unresolved agent target while any pane is booting", () => {
		const primary = noteAgentLaunching("t1", CLAUDE);
		noteAgentSessionAlive("t1", { sessionId: "main", paneId: "%1", launchId: primary });
		noteAgentLaunching("t1", { ...EXTRA, paneId: "%2" });

		expect(agentReadiness("t1")).toBe("booting");
	});

	it("reports gone for a pane whose own session ended, while a sibling lives", () => {
		const primary = noteAgentLaunching("t1", CLAUDE);
		noteAgentSessionAlive("t1", { sessionId: "main", paneId: "%1", launchId: primary });
		noteAgentSessionAlive("t1", { sessionId: "hunter", paneId: "%2", launchId: primary });
		noteAgentSessionEnded("t1", { sessionId: "hunter", paneId: "%2", launchId: primary });

		expect(agentReadiness("t1", "%2")).toBe("gone");
		expect(agentReadiness("t1", "%1")).toBe("ready");
	});

});

// Elapsed time is not proof that a pane became ready or went away. A pane still
// sitting in its trust dialog must never be un-gated by its own timeout.
describe("a boot window closes on evidence, never on a clock", () => {
	it("keeps blocking a pane that has never reported, however long it waits", () => {
		noteAgentLaunching("t1", { ...EXTRA, paneId: "%2", now: 0 });
		// A whole day later, with nothing heard from that pane.
		expect(agentReadiness("t1", "%2")).toBe("booting");
		expect(agentReadiness("t1")).toBe("booting");
	});

	it("closes the window when the pane itself is gone", () => {
		const primary = noteAgentLaunching("t1", CLAUDE);
		noteAgentSessionAlive("t1", { sessionId: "main", paneId: "%1", launchId: primary });
		noteAgentLaunching("t1", { ...EXTRA, paneId: "%2" });
		expect(agentReadiness("t1")).toBe("booting");

		forgetAgentPaneLaunch("t1", "%2");
		expect(agentReadiness("t1")).toBe("ready");
		expect(agentReadiness("t1", "%1")).toBe("ready");
	});

	// The primary agent declining trust emits no SessionEnd — no session ever
	// started. The task must stay unsafe to type into, indefinitely.
	it("never unblocks a primary launch that declined trust and left no SessionEnd", () => {
		noteAgentLaunching("t1", CLAUDE);
		expect(agentReadiness("t1")).toBe("booting");
		// Nothing arrives, ever. Not a receipt, not an end, not a pane death.
		expect(agentReadiness("t1")).toBe("booting");
		expect(agentAcceptsTypedInput("t1")).toBe(false);
		expect(agentAcceptsTypedInput("t1", "%1")).toBe(false);
	});
});

// The one caller that has no alternative: a bug-hunter pane's first prompt is
// pasted into an agent dev3 created seconds ago.
describe("waitForAgentReadiness", () => {
	it("returns at once when the pane is already ready", async () => {
		const primary = noteAgentLaunching("t1", CLAUDE);
		noteAgentSessionAlive("t1", { sessionId: "s", paneId: "%1", launchId: primary });
		const sleep = vi.fn(async () => {});
		await expect(waitForAgentReadiness("t1", "%1", { sleep })).resolves.toBe("ready");
		expect(sleep).not.toHaveBeenCalled();
	});

	it("waits for the pane's own receipt", async () => {
		const extra = noteAgentLaunching("t1", { ...EXTRA, paneId: "%2" });
		let ticks = 0;
		const state = await waitForAgentReadiness("t1", "%2", {
			sleep: async () => {
				ticks += 1;
				// Carries its launch id, as a real hook does — a tokenless receipt is
				// refused outright while a launch is outstanding.
				if (ticks === 3) noteAgentSessionAlive("t1", { sessionId: "hunter", paneId: "%2", launchId: extra });
			},
			now: () => 0,
		});
		expect(state).toBe("ready");
		expect(ticks).toBe(3);
	});

	// A timeout bounds the WAIT, never the gate: the answer is still "not ready",
	// and the caller is the one that decides what to do about it — never to type.
	it("still answers booting when the wait runs out", async () => {
		noteAgentLaunching("t1", { ...EXTRA, paneId: "%2" });
		let clock = 0;
		await expect(waitForAgentReadiness("t1", "%2", {
			timeoutMs: 1_000,
			sleep: async () => { clock += 400; },
			now: () => clock,
		})).resolves.toBe("booting");
	});
});

// Two fail-open paths the coordinator found in the first pass. Both were live,
// both are closed here, and both have to stay closed.
describe("no bypass of the generation token", () => {
	// Measured live before this test existed: a hand-fired receipt with no token
	// flipped a booting task to ready. Anything that can reach the socket without
	// a token — an older CLI, a delayed hook, a hand-run command — would have
	// walked straight past the generation it knows nothing about.
	it("refuses a tokenless receipt while a launch is outstanding", () => {
		noteAgentLaunching("t1", CLAUDE);
		expect(noteAgentSessionAlive("t1", { sessionId: "sneaky", paneId: "%9" })).toBe(false);
		expect(agentReadiness("t1")).toBe("booting");
		expect(agentReadiness("t1", "%9")).toBe("booting");
	});

	it("refuses a tokenless end while a launch is outstanding", () => {
		const primary = noteAgentLaunching("t1", CLAUDE);
		noteAgentSessionAlive("t1", { sessionId: "real", paneId: "%1", launchId: primary });
		noteAgentLaunching("t1", EXTRA);
		expect(noteAgentSessionEnded("t1", { sessionId: "real" })).toBe(false);
		expect(agentReadiness("t1", "%1")).toBe("ready");
	});

	// An app restart, a resumed session or an agent the user started by hand can
	// only report without a token — and with no window open there is no generation
	// for it to bless.
	it("still accepts a tokenless receipt when nothing is outstanding", () => {
		const primary = noteAgentLaunching("t1", CLAUDE);
		noteAgentSessionAlive("t1", { sessionId: "first", launchId: primary });
		expect(noteAgentSessionAlive("t1", { sessionId: "second", paneId: "%2" })).toBe(true);
		expect(agentReadiness("t1", "%2")).toBe("ready");
	});

	it("refuses a receipt naming a launch this task never knew", () => {
		noteAgentLaunching("t1", CLAUDE);
		expect(noteAgentSessionAlive("t1", { sessionId: "x", launchId: "never-issued" })).toBe(false);
		expect(agentReadiness("t1")).toBe("booting");
	});
});

describe("a named pane never inherits the task's answer", () => {
	it("refuses a pane it has no evidence about, even with a sibling ready and nothing pending", () => {
		const primary = noteAgentLaunching("t1", CLAUDE);
		noteAgentSessionAlive("t1", { sessionId: "main", paneId: "%1", launchId: primary });

		expect(agentReadiness("t1")).toBe("ready");
		expect(agentReadiness("t1", "%1")).toBe("ready");
		// %9 is a pane dev3 has heard nothing from. It may hold an agent mid-dialog.
		expect(agentReadiness("t1", "%9")).toBe("booting");
		expect(agentAcceptsTypedInput("t1", "%9")).toBe(false);
	});

	// The one exception, unchanged: a task with no record at all is not something
	// dev3 launched in this run, and our ignorance may not block it.
	it("still answers unknown for a task it never saw launch", () => {
		expect(agentReadiness("t1", "%9")).toBe("unknown");
		expect(agentAcceptsTypedInput("t1", "%9")).toBe(true);
	});
});
