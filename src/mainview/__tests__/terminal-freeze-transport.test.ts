import { describe, expect, it, vi } from "vitest";
import { createTerminalFreezeTrace } from "../terminal-freeze-trace";
import { sendTerminalFreezeTrace } from "../terminal-freeze-transport";

describe("native freeze trace delivery", () => {
	it("posts a native message before entering code that can wedge", () => {
		const fallback = vi.fn();
		const packets: string[] = [];
		const trace = createTerminalFreezeTrace(event => sendTerminalFreezeTrace(event, fallback, {
			postMessage: packet => packets.push(packet),
		}));
		trace.arm({ cols: 80 });
		trace.run("write", () => {
			expect(JSON.parse(packets[packets.length - 1])).toMatchObject({
				type: "message", id: "terminalFreezeTrace", payload: { phase: "begin", stage: "write" },
			});
		});
		expect(fallback).not.toHaveBeenCalled();
		expect(JSON.parse(packets[packets.length - 1]).payload.phase).toBe("end");
	});

	it("uses the browser sink when native IPC is absent or throws", () => {
		const fallback = vi.fn();
		sendTerminalFreezeTrace({ phase: "begin" }, fallback);
		sendTerminalFreezeTrace({ phase: "begin" }, fallback, { postMessage() { throw new Error("closed"); } });
		expect(fallback).toHaveBeenCalledTimes(2);
		expect(() => sendTerminalFreezeTrace({}, () => { throw new Error("closed"); })).not.toThrow();
	});
});
