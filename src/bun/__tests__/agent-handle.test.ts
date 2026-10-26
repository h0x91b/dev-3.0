import { describe, expect, it } from "vitest";
import { agentHandleNames, encodeAgentHandle, parseAgentHandle } from "../../shared/agent-handle";
import { agentReplyCommand } from "../../shared/agent-message-envelope";

const AGENT = { paneId: "%14", sessionId: "conv-1234", paneToken: "srv-token-1", agentProcess: "48213@Mon Oct 26 09:41:07 2026" };

describe("agent handles", () => {
	it("is the pane plus an 8-hex generation: one short shell word", () => {
		const handle = encodeAgentHandle(AGENT);
		expect(handle).toMatch(/^%14\.[0-9a-f]{8}$/);
		expect(encodeAgentHandle({ ...AGENT, paneId: "pane-2" })).toMatch(/^pane-2\.[0-9a-f]{8}$/);
	});

	it("names exactly the agent process it was written for", () => {
		const handle = parseAgentHandle(encodeAgentHandle(AGENT))!;
		expect(handle.paneId).toBe("%14");
		expect(agentHandleNames(handle, AGENT)).toBe(true);
		// The conversation id is not identity: it changes under a live process.
		expect(agentHandleNames(handle, { ...AGENT, sessionId: null })).toBe(true);
	});

	it("does not name a replacement: another process, a recycled pid, a new pane generation, another pane", () => {
		const handle = parseAgentHandle(encodeAgentHandle(AGENT))!;
		expect(agentHandleNames(handle, { ...AGENT, agentProcess: "48214@Mon Oct 26 09:41:07 2026" })).toBe(false);
		expect(agentHandleNames(handle, { ...AGENT, agentProcess: "48213@Mon Oct 26 11:00:00 2026" })).toBe(false);
		expect(agentHandleNames(handle, { ...AGENT, paneToken: "srv-token-2" })).toBe(false);
		expect(agentHandleNames(handle, { ...AGENT, paneId: "%15" })).toBe(false);
	});

	it("survives the whitespace a copy-paste adds", () => {
		expect(parseAgentHandle(`  ${encodeAgentHandle(AGENT)}\n`)).toEqual(parseAgentHandle(encodeAgentHandle(AGENT)));
	});

	it("rejects a raw pane id, the #2062 long form, junk and a truncated handle", () => {
		const handle = encodeAgentHandle(AGENT);
		for (const bad of ["%14", "", "a1.WyIlMTQiLG51bGwsInRvayIsIjFAeCJd", "%14.", "%14.XYZ12345", "%14 .0011aabb", handle.slice(0, -1), `${handle}0`]) {
			expect(parseAgentHandle(bad)).toBeNull();
		}
	});

	it("is what a reply command carries, after the task address", () => {
		const handle = encodeAgentHandle(AGENT);
		expect(agentReplyCommand({ target: { id: "t", seq: 9 }, fromProjectId: "p", quoted: "hi", agentHandle: handle })).toBe(
			`dev3 message --task seq:9 --agent ${handle} --subject "what your reply is about" "hi"`,
		);
	});
});
