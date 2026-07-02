import { describe, it, expect } from "vitest";
import {
	isPidAlive,
	signalPids,
	waitForPidsGone,
	terminatePidsVerified,
	type ReaperDeps,
} from "../process-reaper";

/**
 * Fake process table: each PID has a policy describing how it reacts to
 * signals. `sleep` is instantaneous but advances a virtual clock; policies can
 * schedule delayed deaths against that clock.
 */
type PidPolicy = {
	/** Dies this many virtual ms after receiving SIGTERM (Infinity = ignores it). */
	dieAfterTermMs?: number;
	/** Dies this many virtual ms after receiving SIGKILL (Infinity = unkillable, e.g. D-state). */
	dieAfterKillMs?: number;
};

function makeFakeDeps(policies: Map<number, PidPolicy>): ReaperDeps & {
	signalsSent: Array<{ pid: number; signal: NodeJS.Signals | 0 }>;
	clock: () => number;
} {
	let now = 0;
	const deathAt = new Map<number, number>();
	const signalsSent: Array<{ pid: number; signal: NodeJS.Signals | 0 }> = [];

	const isDead = (pid: number): boolean => {
		const at = deathAt.get(pid);
		return at !== undefined && now >= at;
	};

	return {
		signalsSent,
		clock: () => now,
		kill(pid: number, signal: NodeJS.Signals | 0): void {
			if (!policies.has(pid) || isDead(pid)) {
				throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
			}
			if (signal === 0) return;
			signalsSent.push({ pid, signal });
			const policy = policies.get(pid)!;
			const delay = signal === "SIGTERM" ? policy.dieAfterTermMs : signal === "SIGKILL" ? policy.dieAfterKillMs : undefined;
			if (delay !== undefined && delay !== Infinity) {
				const at = now + delay;
				const existing = deathAt.get(pid);
				if (existing === undefined || at < existing) deathAt.set(pid, at);
			}
		},
		async sleep(ms: number): Promise<void> {
			now += ms;
		},
	};
}

describe("isPidAlive", () => {
	it("returns true for a live pid and false after it dies", async () => {
		const deps = makeFakeDeps(new Map([[100, { dieAfterTermMs: 0 }]]));
		expect(isPidAlive(100, deps)).toBe(true);
		deps.kill(100, "SIGTERM");
		expect(isPidAlive(100, deps)).toBe(false);
	});

	it("returns false for an unknown pid", () => {
		const deps = makeFakeDeps(new Map());
		expect(isPidAlive(424242, deps)).toBe(false);
	});
});

describe("signalPids", () => {
	it("swallows ESRCH for already-gone pids and still signals the rest", () => {
		const deps = makeFakeDeps(new Map([[7, { dieAfterTermMs: 0 }]]));
		signalPids([999, 7], "SIGTERM", deps);
		expect(deps.signalsSent).toEqual([{ pid: 7, signal: "SIGTERM" }]);
	});
});

describe("waitForPidsGone", () => {
	it("returns immediately when all pids are already dead", async () => {
		const deps = makeFakeDeps(new Map());
		const survivors = await waitForPidsGone([1, 2, 3], 5000, 100, deps);
		expect(survivors).toEqual([]);
		expect(deps.clock()).toBe(0);
	});

	it("polls until pids exit instead of sleeping the full timeout", async () => {
		const deps = makeFakeDeps(new Map([[10, { dieAfterTermMs: 250 }]]));
		deps.kill(10, "SIGTERM");
		const survivors = await waitForPidsGone([10], 5000, 100, deps);
		expect(survivors).toEqual([]);
		// Died at t=250 — detected on the poll at t=300, far below the 5s timeout.
		expect(deps.clock()).toBe(300);
	});

	it("returns the survivors when the timeout elapses", async () => {
		const deps = makeFakeDeps(new Map([[11, {}], [12, { dieAfterTermMs: 0 }]]));
		deps.kill(11, "SIGTERM");
		deps.kill(12, "SIGTERM");
		const survivors = await waitForPidsGone([11, 12], 500, 100, deps);
		expect(survivors).toEqual([11]);
	});
});

describe("terminatePidsVerified", () => {
	it("does not SIGKILL processes that exit gracefully on SIGTERM", async () => {
		const deps = makeFakeDeps(new Map([
			[20, { dieAfterTermMs: 100 }],
			[21, { dieAfterTermMs: 200 }],
		]));
		const leftovers = await terminatePidsVerified([20, 21], { termGraceMs: 1500, killWaitMs: 2000, pollMs: 100 }, deps);
		expect(leftovers).toEqual([]);
		expect(deps.signalsSent.filter((s) => s.signal === "SIGKILL")).toEqual([]);
	});

	it("escalates to SIGKILL only for pids that ignore SIGTERM", async () => {
		const deps = makeFakeDeps(new Map([
			[30, { dieAfterTermMs: 100 }],
			[31, { dieAfterTermMs: Infinity, dieAfterKillMs: 0 }],
		]));
		const leftovers = await terminatePidsVerified([30, 31], { termGraceMs: 500, killWaitMs: 1000, pollMs: 100 }, deps);
		expect(leftovers).toEqual([]);
		const killed = deps.signalsSent.filter((s) => s.signal === "SIGKILL").map((s) => s.pid);
		expect(killed).toEqual([31]);
	});

	it("reports pids that survive even SIGKILL instead of claiming success", async () => {
		const deps = makeFakeDeps(new Map([
			[40, { dieAfterTermMs: Infinity, dieAfterKillMs: Infinity }],
		]));
		const leftovers = await terminatePidsVerified([40], { termGraceMs: 300, killWaitMs: 300, pollMs: 100 }, deps);
		expect(leftovers).toEqual([40]);
	});

	it("verifies death before returning — SIGKILL that lands slowly is still waited for", async () => {
		const deps = makeFakeDeps(new Map([
			[50, { dieAfterTermMs: Infinity, dieAfterKillMs: 250 }],
		]));
		const leftovers = await terminatePidsVerified([50], { termGraceMs: 300, killWaitMs: 1000, pollMs: 100 }, deps);
		expect(leftovers).toEqual([]);
	});

	it("returns immediately for an empty pid list without sleeping", async () => {
		const deps = makeFakeDeps(new Map());
		const leftovers = await terminatePidsVerified([], {}, deps);
		expect(leftovers).toEqual([]);
		expect(deps.clock()).toBe(0);
	});
});
