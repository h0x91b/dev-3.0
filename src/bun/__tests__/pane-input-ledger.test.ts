import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The at-most-once ledger on its own: what it guarantees (one delivery id, one
// execution, while the record survives) and what it refuses to pretend (global
// dedup after eviction, expiry, or a replacement process).
vi.mock("../logger", () => ({
	createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { PaneInputLedger, monotonicNowMs, type PaneInputExecution, type PaneInputLedgerOptions } from "../pane-input-ledger";
import {
	PANE_INPUT_LIMITS,
	type PaneIncarnation,
	type PaneInputOutcome,
	type PaneInputProgram,
} from "../../shared/pane-input";

const TASK_ID = "ef0ea197-8cac-4134-99dc-1566191ccca7";

/** A native pin, with only the fields a case wants changed. */
function incarnation(over: Partial<Extract<PaneIncarnation, { backend: "native" }>> = {}): PaneIncarnation {
	return {
		backend: "native",
		taskId: TASK_ID,
		paneId: "pane-2",
		sessionId: "s",
		host: { pid: 1, startSignature: "host-sig" },
		shell: { pid: 2, startSignature: "shell-sig" },
		...over,
	};
}

function program(overrides: Partial<PaneInputProgram> = {}): PaneInputProgram {
	return {
		deliveryId: "d1",
		attempt: 1,
		incarnation: incarnation(),
		stages: [{ steps: [{ kind: "text", text: "hello" }] }],
		...overrides,
	};
}

function delivered(p: PaneInputProgram, acceptedThrough = 1): PaneInputOutcome {
	return { deliveryId: p.deliveryId, backend: "tmux", paneId: p.incarnation.paneId, status: "delivered", acceptedThrough };
}

/** Let the ledger's pane queue hop its microtasks — execution is deliberately deferred. */
function tick(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

const MAX_RECORDS = 64;
const RETENTION_MS = 60_000;

/** A fresh ledger per case: nothing here can reach the production one. */
let ledger: PaneInputLedger;
let clock = 0;
const now = (): number => clock;

function makeLedger(opts: PaneInputLedgerOptions = {}): PaneInputLedger {
	return new PaneInputLedger({ now, retentionMs: RETENTION_MS, maxRecords: MAX_RECORDS, ...opts });
}

/** Shorthand so each case reads like the old free function. */
const run = (
	program: PaneInputProgram,
	execute: (execution: PaneInputExecution) => Promise<PaneInputOutcome>,
): Promise<PaneInputOutcome> => ledger.run(program, execute);

beforeEach(() => {
	clock = 1_000;
	ledger = makeLedger();
});
afterEach(() => vi.useRealTimers());

// Deadlines and retention are measured with this clock. On Date.now() a wall-clock jump —
// NTP, DST, a user changing the date — would expire live records or hold dead ones forever.
// Every case below injects its own windows, so the PRODUCTION defaults were unpinned:
// confirmMs at 30s would silently hold a pane for half a minute with nothing red.
describe("the production defaults are the ones a real pane gets", () => {
	it("holds a wedged pane for its grace plus confirm window, and no longer", async () => {
		const clock = { now: 0 };
		const ledger = new PaneInputLedger({ now: () => clock.now });
		const wedged: PaneInputProgram = {
			deliveryId: "defaults",
			attempt: 1,
			incarnation: incarnation(),
			stages: [{ steps: [{ kind: "text", text: "hello" }] }],
		};

		const started = ledger.run(wedged, () => new Promise<PaneInputOutcome>(() => undefined));
		// Default deadline 5s + grace 2s + confirm 3s = 10s of real waiting; the injected
		// clock decides the deadline, real timers decide grace and confirm.
		const outcome = await Promise.race<PaneInputOutcome | "still waiting">([
			started,
			new Promise((resolve) => setTimeout(() => resolve("still waiting"), 11_000)),
		]);
		expect(outcome).not.toBe("still waiting");
		expect(outcome).toMatchObject({ status: "indeterminate", reason: "backend-failure" });
		if (typeof outcome === "string" || outcome.status !== "indeterminate") return;
		expect(outcome.detail).toContain("within 3000ms");
	}, 20_000);

	// graceMs was only half pinned: raising it tripped the case above, but DROPPING it to
	// zero left the total wait unchanged, because an executor that settles inside confirmMs
	// still returns its own outcome. An executor that reports honestly on abort sees it.
	it("lets an executor overrun its deadline by the grace window before aborting it", async () => {
		const clock = { now: 0 };
		const ledger = new PaneInputLedger({ now: () => clock.now });
		const late: PaneInputProgram = {
			deliveryId: "late-but-within-grace",
			attempt: 1,
			incarnation: incarnation(),
			stages: [{ steps: [{ kind: "text", text: "hello" }] }],
			deadlineMs: 30,
		};

		// Resolves 400ms late: inside the default 2s grace, so it is never aborted.
		const outcome = await ledger.run(late, async (execution) => {
			await new Promise((resolve) => setTimeout(resolve, 400));
			if (execution.signal.aborted) {
				return { deliveryId: late.deliveryId, backend: "tmux" as const, paneId: "pane-2", status: "indeterminate" as const, possiblyAcceptedThrough: 1, reason: "deadline-exceeded" as const, detail: "aborted" };
			}
			return delivered(late);
		});

		expect(outcome).toMatchObject({ status: "delivered" });
	}, 15_000);

	// maxRecords had no assertion at all outside production: 64 to 4 stayed green.
	it("admits its full default number of in-flight deliveries, and refuses the next", async () => {
		const clock = { now: 0 };
		const ledger = new PaneInputLedger({ now: () => clock.now });
		const gate = deferred<PaneInputOutcome>();
		let admitted = 0;
		// Distinct panes, so none of them queues behind another and all 64 are in flight.
		const inFlight = Array.from({ length: 64 }, (_unused, index) =>
			ledger.run(
				{
					deliveryId: `bulk-${index}`,
					attempt: 1,
					incarnation: incarnation({ paneId: `pane-${index}` }),
					stages: [{ steps: [{ kind: "text", text: "hello" }] }],
				},
				() => {
					admitted += 1;
					return gate.promise;
				},
			),
		);
		await tick();
		// Counting executions, not outcomes: a SMALLER default refuses most of these, and
		// their refusals look exactly like the one asserted below.
		expect(admitted).toBe(64);

		const refused = await ledger.run(
			{
				deliveryId: "one-too-many",
				attempt: 1,
				incarnation: incarnation({ paneId: "pane-overflow" }),
				stages: [{ steps: [{ kind: "text", text: "hello" }] }],
			},
			async () => delivered(program()),
		);
		expect(refused).toMatchObject({ status: "not-started", reason: "executor-saturated", retryableAsNewDelivery: true });

		gate.resolve(delivered(program()));
		await Promise.all(inFlight);
	}, 15_000);

	it("keeps a settled record for its retention window, and evicts after it", async () => {
		const clock = { now: 0 };
		const ledger = new PaneInputLedger({ now: () => clock.now });
		const sent: PaneInputProgram = {
			deliveryId: "retained",
			attempt: 1,
			incarnation: incarnation(),
			stages: [{ steps: [{ kind: "text", text: "hello" }] }],
		};
		const execute = vi.fn(async () => delivered(sent));

		await ledger.run(sent, execute);
		// Inside the default 60s window the record still answers; past it, the id is unknown
		// and an attempt-1 replay would execute again.
		clock.now = 59_000;
		await ledger.run(sent, execute);
		expect(execute).toHaveBeenCalledTimes(1);
		clock.now = 61_000;
		await ledger.run(sent, execute);
		expect(execute).toHaveBeenCalledTimes(2);
	});
});

describe("the ledger clock ignores the wall clock", () => {
	afterEach(() => vi.useRealTimers());

	it("does not move when the system time jumps by a day", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
		const before = monotonicNowMs();
		vi.setSystemTime(new Date("2026-01-02T00:00:00Z"));
		const after = monotonicNowMs();
		expect(Math.abs(after - before)).toBeLessThan(1_000);
	});
});

describe("one delivery id runs at most once while the record survives", () => {
	it("executes a first attempt and stamps the executor incarnation", async () => {
		const execute = vi.fn(async () => delivered(program()));
		const outcome = await run(program(), execute);
		expect(execute).toHaveBeenCalledTimes(1);
		expect(outcome).toMatchObject({ status: "delivered", executor: ledger.incarnation });
	});

	it("replays the recorded outcome instead of writing a second time", async () => {
		const execute = vi.fn(async () => delivered(program()));
		const first = await run(program(), execute);
		const second = await run(program(), execute);
		expect(execute).toHaveBeenCalledTimes(1);
		expect(second).toEqual(first);
	});

	it("lets an in-flight duplicate join the original instead of guessing", async () => {
		const gate = deferred<PaneInputOutcome>();
		const execute = vi.fn(() => gate.promise);
		const first = run(program(), execute);
		const duplicate = run(program(), execute);
		gate.resolve(delivered(program()));
		const [a, b] = await Promise.all([first, duplicate]);
		expect(execute).toHaveBeenCalledTimes(1);
		expect(b).toEqual(a);
	});

});

describe("a reused id with a different payload is refused, never executed", () => {
	it("rejects different text under the same delivery id", async () => {
		const execute = vi.fn(async () => delivered(program()));
		await run(program(), execute);
		const outcome = await run(
			program({ stages: [{ steps: [{ kind: "text", text: "something else" }] }] }),
			execute,
		);
		expect(execute).toHaveBeenCalledTimes(1);
		expect(outcome).toMatchObject({ status: "not-started", reason: "duplicate-mismatch", retryableAsNewDelivery: false });
	});

	// The key is the FULL incarnation, so the same id against a SUCCESSOR pane is a new
	// delivery — not a payload mismatch against its predecessor's record.
	it("admits the same delivery id against a successor incarnation", async () => {
		const execute = vi.fn(async () => delivered(program()));
		await run(program(), execute);
		const successor = program({ incarnation: incarnation({ host: { pid: 1, startSignature: "successor-sig" } }) });
		const outcome = await run(successor, execute);
		expect(execute).toHaveBeenCalledTimes(2);
		expect(outcome.status).toBe("delivered");
	});

	it("keeps deliveries of two different panes independent", async () => {
		const execute = vi.fn(async () => delivered(program()));
		await run(program(), execute);
		await run(
			program({ incarnation: incarnation({ paneId: "pane-3", sessionId: "s3" }) }),
			execute,
		);
		expect(execute).toHaveBeenCalledTimes(2);
	});
});

describe("the guarantee is scoped, and says so when the record is gone", () => {
	it("answers indeterminate for a resend with no record, rather than re-running it", async () => {
		const execute = vi.fn(async () => delivered(program()));
		const outcome = await run(program({ attempt: 2 }), execute);
		expect(execute).not.toHaveBeenCalled();
		expect(outcome).toMatchObject({
			status: "indeterminate",
			reason: "owner-process-replaced",
			possiblyAcceptedThrough: 1,
			executor: ledger.incarnation,
		});
	});

	it("still replays a record it does have, whatever the attempt number says", async () => {
		const execute = vi.fn(async () => delivered(program()));
		const first = await run(program(), execute);
		const resend = await run(program({ attempt: 3 }), execute);
		expect(execute).toHaveBeenCalledTimes(1);
		expect(resend).toEqual(first);
	});

	it("treats a resend after the owning process was replaced as unknown, not as new", async () => {
		const execute = vi.fn(async () => delivered(program()));
		await run(program(), execute);
		// A replacement process starts with an empty ledger — same observable state.
		ledger = makeLedger();
		const outcome = await run(program({ attempt: 2 }), execute);
		expect(execute).toHaveBeenCalledTimes(1);
		expect(outcome).toMatchObject({ status: "indeterminate", reason: "owner-process-replaced" });
	});

	it("forgets a record once the retention window passes", async () => {
		const execute = vi.fn(async () => delivered(program()));
		await run(program(), execute);

		clock += RETENTION_MS + 1;
		const outcome = await run(program({ attempt: 2 }), execute);
		expect(execute).toHaveBeenCalledTimes(1);
		expect(outcome).toMatchObject({ status: "indeterminate", reason: "owner-process-replaced" });
	});

	it("keeps answering inside the retention window", async () => {
		const execute = vi.fn(async () => delivered(program()));
		const first = await run(program(), execute);

		clock += RETENTION_MS - 1;
		const resend = await run(program({ attempt: 2 }), execute);
		expect(execute).toHaveBeenCalledTimes(1);
		expect(resend).toEqual(first);
	});

	it("re-admits a first attempt whose record expired, because nothing remembers it", async () => {
		const execute = vi.fn(async () => delivered(program()));
		await run(program(), execute);

		clock += RETENTION_MS + 1;
		await run(program(), execute);
		// Documented consequence: reuse after eviction is unsupported, so it runs again.
		expect(execute).toHaveBeenCalledTimes(2);
	});
});

describe("admission is bounded, in-flight entries included", () => {
	it(`refuses the ${MAX_RECORDS + 1}th concurrent delivery instead of forgetting one`, async () => {
		const gate = deferred<PaneInputOutcome>();
		const held: Promise<PaneInputOutcome>[] = [];
		for (let i = 0; i < MAX_RECORDS; i += 1) {
			held.push(
				run(
					program({ deliveryId: `d${i}`, incarnation: incarnation({ paneId: `pane-${i}`, sessionId: `s${i}` }) }),
					() => gate.promise,
				),
			);
		}
		const execute = vi.fn(async () => delivered(program({ deliveryId: "overflow" })));
		const refused = await run(program({ deliveryId: "overflow" }), execute);

		expect(execute).not.toHaveBeenCalled();
		expect(refused).toMatchObject({ status: "not-started", reason: "executor-saturated", retryableAsNewDelivery: true });

		gate.resolve(delivered(program()));
		await Promise.all(held);
	});

	it("admits again by evicting the oldest SETTLED record", async () => {
		for (let i = 0; i < MAX_RECORDS; i += 1) {
			await run(
				program({ deliveryId: `d${i}`, incarnation: incarnation({ paneId: `pane-${i}`, sessionId: `s${i}` }) }),
				async () => delivered(program({ deliveryId: `d${i}` })),
			);
		}
		const execute = vi.fn(async () => delivered(program({ deliveryId: "extra" })));
		const outcome = await run(program({ deliveryId: "extra" }), execute);
		expect(execute).toHaveBeenCalledTimes(1);
		expect(outcome.status).toBe("delivered");
	});

});

describe("an aborted executor must confirm it stopped before anything else runs", () => {
	beforeEach(() => {
		ledger = makeLedger({ graceMs: 20, confirmMs: 20 });
	});

	it("releases the pane only after the executor confirms the backend stopped", async () => {
		const order: string[] = [];
		let seenAbort = false;
		const first = run(program({ deliveryId: "aborting", deadlineMs: 30 }), async (execution) => {
			order.push("first:start");
			await new Promise<void>((resolve) => execution.signal.addEventListener("abort", () => resolve(), { once: true }));
			seenAbort = true;
			// Confirmed stop: only now may a successor touch this pane.
			await new Promise((resolve) => setTimeout(resolve, 5));
			order.push("first:stopped");
			return delivered(program({ deliveryId: "aborting" }));
		});
		const second = run(program({ deliveryId: "after" }), async () => {
			order.push("second:start");
			return delivered(program({ deliveryId: "after" }));
		});

		await Promise.all([first, second]);
		expect(seenAbort).toBe(true);
		expect(order).toEqual(["first:start", "first:stopped", "second:start"]);
	});

	// Progress is only worth recording if it reaches a caller: an executor that wedges
	// reports how far it got, and that bound rides out in the refusal.
	it("carries the progress an unconfirmed executor reported into its refusal", async () => {
		const wedged = program({ deliveryId: "reported-progress", deadlineMs: 30 });
		const outcome = await run(wedged, (execution) => {
			execution.progress(3);
			return new Promise<PaneInputOutcome>(() => undefined);
		});
		expect(outcome.status).toBe("indeterminate");
		if (outcome.status !== "indeterminate") return;
		expect(outcome.detail).toContain("after accepting 3 stage(s)");
	});

	// An executor that never confirms may still be writing, so the incarnation is closed
	// rather than handed to a successor.
	it("quarantines the pane incarnation when the stop is never confirmed", async () => {
		const wedged = program({ deliveryId: "wedged", deadlineMs: 30 });
		const outcome = await run(wedged, () => new Promise<PaneInputOutcome>(() => undefined));

		expect(outcome).toMatchObject({
			status: "indeterminate",
			reason: "backend-failure",
			executor: ledger.incarnation,
		});
		if (outcome.status !== "indeterminate") return;
		expect(outcome.detail).toContain("did not confirm its backend stopped");
	});

	// The race: B is admitted while A still runs, waits behind it, and A then quarantines.
	// Checking only at admission would let B start against an unconfirmed A.
	it("refuses a program that was already queued when the pane became quarantined", async () => {
		const queued = vi.fn(async () => delivered(program({ deliveryId: "queued" })));
		const wedged = run(
			program({ deliveryId: "wedged", deadlineMs: 30 }),
			() => new Promise<PaneInputOutcome>(() => undefined),
		);
		// Admitted now, executes only after the wedged one gives up.
		const behind = run(program({ deliveryId: "queued" }), queued);

		const [first, second] = await Promise.all([wedged, behind]);
		expect(first).toMatchObject({ status: "indeterminate", reason: "backend-failure" });
		expect(queued).not.toHaveBeenCalled();
		expect(second).toMatchObject({ status: "indeterminate", reason: "backend-failure" });
		if (second.status !== "indeterminate") return;
		expect(second.detail).toContain("quarantined");
	});

	it("refuses every successor on a quarantined incarnation, but not other panes", async () => {
		const wedged = program({ deliveryId: "wedged", deadlineMs: 30 });
		await run(wedged, () => new Promise<PaneInputOutcome>(() => undefined));

		const blocked = vi.fn(async () => delivered(program({ deliveryId: "blocked" })));
		const successor = await run(program({ deliveryId: "blocked" }), blocked);
		expect(blocked).not.toHaveBeenCalled();
		expect(successor).toMatchObject({ status: "indeterminate", reason: "backend-failure" });
		if (successor.status !== "indeterminate") return;
		expect(successor.detail).toContain("quarantined");

		// A different pane incarnation is unaffected.
		const elsewhere = vi.fn(async () => delivered(program({ deliveryId: "elsewhere" })));
		const other = await run(
			program({ deliveryId: "elsewhere", incarnation: incarnation({ paneId: "pane-9", sessionId: "s9" }) }),
			elsewhere,
		);
		expect(elsewhere).toHaveBeenCalledTimes(1);
		expect(other.status).toBe("delivered");
	});

	// The one thing a released queue must never allow: the old executor waking up later
	// and writing while a successor is running.
	it("never lets a late executor overlap a successor", async () => {
		const writes: string[] = [];
		const late = program({ deliveryId: "late", deadlineMs: 30 });
		await run(late, async () => {
			await new Promise((resolve) => setTimeout(resolve, 200));
			writes.push("late");
			return delivered(late);
		});
		// Quarantined, so nothing else was admitted for this incarnation at all.
		const blocked = vi.fn(async () => {
			writes.push("successor");
			return delivered(program({ deliveryId: "blocked" }));
		});
		await run(program({ deliveryId: "blocked" }), blocked);
		await new Promise((resolve) => setTimeout(resolve, 250));

		expect(blocked).not.toHaveBeenCalled();
		expect(writes).toEqual(["late"]);
	});

	it("settles a rejected executor, so a thrown program cannot saturate the ledger", async () => {
		for (let i = 0; i < MAX_RECORDS; i += 1) {
			const boom = run(
				program({ deliveryId: `boom${i}`, incarnation: incarnation({ paneId: `pane-${i}`, sessionId: `s${i}` }) }),
				async () => {
					throw new Error("executor exploded");
				},
			);
			await expect(boom).rejects.toThrow("executor exploded");
		}
		const execute = vi.fn(async () => delivered(program({ deliveryId: "after" })));
		const outcome = await run(program({ deliveryId: "after" }), execute);
		expect(execute).toHaveBeenCalledTimes(1);
		expect(outcome.status).toBe("delivered");
	});
});

describe("the deadline starts when the ledger admits the request", () => {
	it("charges time spent queued behind another program for the same pane", async () => {
		const gate = deferred<PaneInputOutcome>();
		const first = run(program({ deliveryId: "first" }), () => gate.promise);

		let secondDeadline = 0;
		const second = run(
			program({ deliveryId: "second", deadlineMs: PANE_INPUT_LIMITS.defaultDeadlineMs }),
			async (execution) => {
				secondDeadline = execution.deadlineAtMs;
				return delivered(program({ deliveryId: "second" }));
			},
		);

		await new Promise((resolve) => setTimeout(resolve, 30));
		gate.resolve(delivered(program({ deliveryId: "first" })));
		await Promise.all([first, second]);

		// Admitted before the queue wait, so by the time it ran its budget had shrunk.
		const { monotonicNowMs } = await import("../pane-input-ledger");
		expect(secondDeadline).toBeLessThan(monotonicNowMs() + PANE_INPUT_LIMITS.defaultDeadlineMs);
	});
});

describe("programs for one pane are serialized", () => {
	it("never overlaps two programs targeting the same pane", async () => {
		const order: string[] = [];
		const firstGate = deferred<PaneInputOutcome>();
		const first = run(program({ deliveryId: "a" }), () => {
			order.push("a:start");
			return firstGate.promise;
		});
		const second = run(program({ deliveryId: "b" }), async () => {
			order.push("b:start");
			return delivered(program({ deliveryId: "b" }));
		});

		await tick();
		expect(order).toEqual(["a:start"]);

		firstGate.resolve(delivered(program({ deliveryId: "a" })));
		await Promise.all([first, second]);
		expect(order).toEqual(["a:start", "b:start"]);
	});

	it("does not let a thrown program strand the pane's queue", async () => {
		const boom = run(program({ deliveryId: "boom" }), async () => {
			throw new Error("executor exploded");
		});
		await expect(boom).rejects.toThrow("executor exploded");

		const after = await run(program({ deliveryId: "after" }), async () =>
			delivered(program({ deliveryId: "after" })),
		);
		expect(after.status).toBe("delivered");
	});

	it("runs programs for different panes concurrently", async () => {
		const order: string[] = [];
		const gate = deferred<PaneInputOutcome>();
		const held = run(program({ deliveryId: "held" }), () => {
			order.push("held:start");
			return gate.promise;
		});
		const other = run(
			program({ deliveryId: "other", incarnation: incarnation({ paneId: "pane-9", sessionId: "s9" }) }),
			async () => {
				order.push("other:start");
				return delivered(program({ deliveryId: "other" }));
			},
		);
		await other;
		expect(order).toEqual(["held:start", "other:start"]);
		gate.resolve(delivered(program({ deliveryId: "held" })));
		await held;
	});
});
