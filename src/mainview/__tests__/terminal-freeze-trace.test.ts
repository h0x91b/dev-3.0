import { describe, expect, it } from "vitest";
import { createTerminalFreezeTrace, type TerminalFreezeTraceEvent } from "../terminal-freeze-trace";

function fixture(options: { windowMs?: number; maxSpans?: number } = {}) {
	let clock = 100;
	const events: TerminalFreezeTraceEvent[] = [];
	const trace = createTerminalFreezeTrace((event) => events.push(event), { ...options, now: () => clock });
	return { events, trace, advance: (ms: number) => { clock += ms; } };
}

describe("createTerminalFreezeTrace", () => {
	it("is silent before arming and emits begin before executing work", () => {
		const { trace, events, advance } = fixture();
		expect(trace.run("write", () => 7)).toBe(7);
		expect(events).toEqual([]);
		trace.arm({ cols: 80, rows: 24 });
		expect(events[0]).toMatchObject({ phase: "arm", capture: 1, cols: 80, rows: 24 });
		const result = {};
		expect(trace.run("write", () => {
			expect(events[events.length - 1]).toMatchObject({ phase: "begin", stage: "write", spanId: 1, bytes: 42 });
			advance(12);
			return result;
		}, { bytes: 42 })).toBe(result);
		expect(events[events.length - 1]).toMatchObject({ phase: "end", spanId: 1, durationMs: 12, outcome: "ok" });
	});

	it("preserves thrown values and ends spans after their capture expires", () => {
		const { trace, events, advance } = fixture({ windowMs: 10 });
		const failure = { terminalFailure: true };
		trace.arm({});
		let caught: unknown;
		try {
			trace.run("render", () => { advance(11); throw failure; });
		} catch (error) {
			caught = error;
		}
		expect(caught).toBe(failure);
		expect(events[events.length - 1]).toMatchObject({ phase: "end", durationMs: 11, outcome: "throw" });
		expect(trace.run("render", () => "still works")).toBe("still works");
		expect(events).toHaveLength(3);
	});

	it("stops starting spans at the expiration boundary", () => {
		const { trace, events, advance } = fixture();
		trace.arm({});
		advance(10_000);
		trace.run("render", () => undefined);
		expect(events).toHaveLength(1);
	});

	it("bounds nested spans and reports exhaustion only once per capture", () => {
		const { trace, events } = fixture({ maxSpans: 2 });
		trace.arm({});
		trace.run("outer", () => {
			trace.run("inner", () => undefined);
			expect(trace.run("skipped", () => 3)).toBe(3);
			trace.run("also-skipped", () => undefined);
		});
		expect(events.map(({ phase, spanId }) => [phase, spanId])).toEqual([
			["arm", undefined], ["begin", 1], ["begin", 2], ["end", 2],
			["limit-reached", undefined], ["end", 1],
		]);
		trace.arm({});
		trace.run("fresh", () => undefined);
		expect(events[events.length - 1]).toMatchObject({ capture: 2, spanId: 3, phase: "end" });
	});

	it("keeps an outer span attached to its original capture when rearmed inside it", () => {
		const { trace, events } = fixture();
		trace.arm({});
		trace.run("outer", () => {
			trace.arm({});
			trace.run("inner", () => undefined);
		});
		expect(events[events.length - 2]).toMatchObject({ phase: "end", capture: 2, spanId: 2 });
		expect(events[events.length - 1]).toMatchObject({ phase: "end", capture: 1, spanId: 1 });
	});

	it("isolates sink failures from callback results and thrown values", () => {
		const trace = createTerminalFreezeTrace(() => { throw new Error("sink failed"); }, { maxSpans: 1 });
		trace.arm({});
		expect(trace.run("render", () => 42)).toBe(42);
		expect(trace.run("skipped", () => 43)).toBe(43);
		trace.arm({});
		const failure = new Error("callback failed");
		expect(() => trace.run("render", () => { throw failure; })).toThrow(failure);
	});

	it("gives each terminal trace a distinct identity and protects reserved fields", () => {
		const first = fixture();
		const second = fixture();
		first.trace.arm({ capture: 999, phase: "fake" });
		second.trace.arm({});
		expect(first.events[0]!.traceId).not.toBe(second.events[0]!.traceId);
		expect(first.events[0]).toMatchObject({ capture: 1, phase: "arm" });
		first.trace.run("render", () => undefined, { capture: 999, spanId: 999, stage: "fake", phase: "fake" });
		expect(first.events[1]).toMatchObject({ capture: 1, spanId: 1, stage: "render", phase: "begin" });
	});
});
