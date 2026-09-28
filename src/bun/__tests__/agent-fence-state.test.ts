import { describe, expect, it } from "vitest";
import {
	agentFenceSentinel,
	isPinnableAgentFence,
	parseAgentFence,
	pinnableAgentFence,
} from "../../shared/agent-fence";

describe("parseAgentFence", () => {
	it("reads the three forms a wrapper writes", () => {
		expect(parseAgentFence("")).toEqual({ kind: "legacy" });
		expect(parseAgentFence("open:a1-B2")).toEqual({ kind: "open", launchId: "a1-B2" });
		expect(parseAgentFence("closed:a1-B2:143")).toEqual({ kind: "closed", launchId: "a1-B2", exitCode: 143 });
		expect(parseAgentFence("closed:x:0")).toEqual({ kind: "closed", launchId: "x", exitCode: 0 });
	});

	// Anything else was not written by dev3's wrapper: it fails closed and is never pinned,
	// so it can never be interpolated into the guard's format.
	it.each([
		"open:",
		"open:a b",
		"open:x},1}",
		"closed:x:256",
		"closed:x:01",
		"closed:x",
		"closed:x:1:2",
		`open:${"a".repeat(65)}`,
		"OPEN:x",
	])("treats %j as malformed", (raw) => {
		expect(parseAgentFence(raw).kind).toBe("malformed");
		expect(pinnableAgentFence(parseAgentFence(raw))).toBeNull();
	});

	it("pins only a legacy pane or an open fence", () => {
		expect(pinnableAgentFence({ kind: "legacy" })).toBe("");
		expect(pinnableAgentFence({ kind: "open", launchId: "L1" })).toBe("open:L1");
		expect(pinnableAgentFence({ kind: "closed", launchId: "L1", exitCode: 0 })).toBeNull();
		expect(isPinnableAgentFence("")).toBe(true);
		expect(isPinnableAgentFence("open:L1")).toBe(true);
		expect(isPinnableAgentFence("closed:L1:0")).toBe(false);
		expect(isPinnableAgentFence("open:L1}")).toBe(false);
	});
});

describe("agentFenceSentinel", () => {
	it("wraps a 16-hex nonce in unit separators and refuses anything else", () => {
		expect(agentFenceSentinel("0123456789abcdef")).toBe("\x1fdev3-fence:0123456789abcdef\x1f");
		expect(() => agentFenceSentinel("0123")).toThrow();
		expect(() => agentFenceSentinel("0123456789abcdeg")).toThrow();
	});
});
