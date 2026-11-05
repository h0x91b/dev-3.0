import { afterEach, describe, expect, it } from "vitest";
import { decodeAgentHandle, encodeAgentHandle } from "../../shared/agent-handle";
import { agentReplyCommand } from "../../shared/agent-message-envelope";
import type { ScheduledMessageAuthor } from "../../shared/types";

/** The shape a real tmux sender has: UUID conversation, UUID server token, `pid@<ps lstart>`. */
const AGENT: ScheduledMessageAuthor = {
	paneId: "%14",
	sessionId: "3f6c2a1e-8b7d-4c19-9e2f-5a0b7c3d1e42",
	paneToken: "d1a7f0c2-6e3b-4a95-8c1d-2b9e4f7a0c63",
	agentProcess: "48213@Mon Oct 26 21:02:11 2026",
};

const roundTrip = (author: ScheduledMessageAuthor) => decodeAgentHandle(encodeAgentHandle(author));
const bytesOf = (handle: string) => Buffer.from(handle, "base64url");

describe("agent handles — a pane generation is not part of the handle", () => {
	it("encodes the same handle with or without it, and decodes to the four stored fields", () => {
		const native = { ...AGENT, paneId: "pane-1", paneToken: "native-s1" };
		const withGeneration = { ...native, paneGeneration: "4100@Mon Oct 26 21:02:11 2026" };
		expect(encodeAgentHandle(withGeneration)).toBe(encodeAgentHandle(native));
		expect(decodeAgentHandle(encodeAgentHandle(withGeneration))).toEqual(native);
	});
});

describe("agent handles — lossless", () => {
	const savedTz = process.env.TZ;
	afterEach(() => {
		process.env.TZ = savedTz;
	});

	it("round-trips the exact binding and is one shell word", () => {
		const handle = encodeAgentHandle(AGENT);
		expect(decodeAgentHandle(handle)).toEqual(AGENT);
		expect(handle).toMatch(/^[A-Za-z0-9_-]+$/);
		// version 1 + pane 2 + two UUIDs 2×17 + process 1+3+5: every field took its compact form.
		expect(bytesOf(handle)).toHaveLength(46);
		expect(handle).toHaveLength(62);
	});

	it("round-trips native pane ids, a missing conversation, and ids that are not lowercase UUIDs", () => {
		for (const author of [
			{ ...AGENT, paneId: "pane-1" },
			{ ...AGENT, paneId: "pane-12", paneToken: "native-s2" },
			{ ...AGENT, paneId: "%0" },
			{ ...AGENT, sessionId: null },
			{ ...AGENT, sessionId: "conv-1234", paneToken: "gen-1" },
			{ ...AGENT, sessionId: AGENT.sessionId!.toUpperCase() },
			{ ...AGENT, paneId: "weird pane/ü", sessionId: "ü-session" },
			{ ...AGENT, paneId: "%07" },
		]) {
			expect(roundTrip(author)).toEqual(author);
		}
	});

	it("round-trips every start text exactly, compact or not", () => {
		for (const agentProcess of [
			"7@Thu Jan 1 00:00:00 1970",
			"4294967295@Tue Feb 29 23:59:59 2028",
			"48213@Mon Oct 5 09:00:00 2026",
			"48213@Mon Oct  5 09:00:00 2026", // unnormalized spacing
			"48213@Tue Oct 26 21:02:11 2026", // weekday that does not match the date
			"48213@lun. oct. 26 21:02:11 2026", // localized `ps`
			"48213@Mon Oct 26 21:02:11 2026 +0200",
			"48213@Mon Oct 26 25:02:11 2026",
			"48213@x",
		]) {
			expect(roundTrip({ ...AGENT, agentProcess })).toEqual({ ...AGENT, agentProcess });
		}
	});

	it("packs the Linux `/proc` signature compactly, and keeps any other spelling of it raw", () => {
		const linux = { ...AGENT, agentProcess: "48213@linux:5b1e7c2a-9d3f-4e61-8a0b-2c4d6e8f0a1b:4652300" };
		expect(roundTrip(linux)).toEqual(linux);
		expect(bytesOf(encodeAgentHandle(linux)).length).toBeLessThan(bytesOf(encodeAgentHandle(AGENT)).length + 16);
		for (const agentProcess of [
			"48213@linux:5B1E7C2A-9D3F-4E61-8A0B-2C4D6E8F0A1B:4652300",
			"48213@linux:5b1e7c2a-9d3f-4e61-8a0b-2c4d6e8f0a1b:04652300",
			"48213@linux:not-a-boot-id:4652300",
			"48213@linux:5b1e7c2a-9d3f-4e61-8a0b-2c4d6e8f0a1b:9999999999999999999",
		]) {
			expect(roundTrip({ ...AGENT, agentProcess })).toEqual({ ...AGENT, agentProcess });
		}
	});

	it("does not depend on the machine's timezone, DST included", () => {
		const atDstEdge = { ...AGENT, agentProcess: "48213@Sun Mar 29 02:30:00 2026" }; // a wall time that does not exist in Europe
		const encoded = [encodeAgentHandle(AGENT), encodeAgentHandle(atDstEdge)];
		for (const tz of ["UTC", "Asia/Jerusalem", "America/New_York", "Europe/Berlin", "Pacific/Chatham"]) {
			process.env.TZ = tz;
			expect([encodeAgentHandle(AGENT), encodeAgentHandle(atDstEdge)]).toEqual(encoded);
			expect(decodeAgentHandle(encoded[1]!)).toEqual(atDstEdge);
		}
	});

	it("survives the whitespace a copy-paste adds", () => {
		expect(decodeAgentHandle(`  ${encodeAgentHandle(AGENT)}\n`)).toEqual(AGENT);
	});

	it("rejects an old #2062 handle, a raw pane id, junk, a truncated or extended handle and another version", () => {
		const handle = encodeAgentHandle(AGENT);
		const bytes = bytesOf(handle);
		const wrongVersion = Buffer.from([9, ...bytes.subarray(1)]).toString("base64url");
		const trailing = Buffer.from([...bytes, 0]).toString("base64url");
		for (const bad of [
			"a1.WyIlMTQiLG51bGwsInRvayIsIjFAeCJd", "%14", "", "!!!", handle.slice(0, -2), handle.slice(0, 10), wrongVersion, trailing,
		]) {
			expect(decodeAgentHandle(bad)).toBeNull();
		}
	});

	it("rejects bytes that decode but do not describe one agent process, or that it never writes", () => {
		const forge = (...bytes: number[]) => Buffer.from(bytes).toString("base64url");
		const raw = (text: string) => [0, text.length, ...Buffer.from(text)];
		expect(decodeAgentHandle(forge(2, 1, 3, 3, ...raw("tok"), ...raw("1@x")))).toEqual({ paneId: "%3", sessionId: null, paneToken: "tok", agentProcess: "1@x" });
		for (const bytes of [
			[2, 1, 3, 3, ...raw(""), ...raw("1@x")], // empty pane generation
			[2, 1, 3, 3, 3, ...raw("1@x")], // no pane generation at all
			[2, 1, 3, 3, ...raw("tok"), ...raw("0@x")], // pid 0
			[2, 1, 3, 3, ...raw("tok"), ...raw("no-pid")],
			[2, 0, 0, 3, ...raw("tok"), ...raw("1@x")], // empty pane id
			[2, 1, 3, 0, 0, ...raw("tok"), ...raw("1@x")], // empty conversation id
			[2, 0, ...raw("%3").slice(1), 3, ...raw("tok"), ...raw("1@x")], // `%3` spelled raw: not how it is written
			[2, 1, 0x83, 0, 3, ...raw("tok"), ...raw("1@x")], // overlong varint
			[2, 7, 3, 3, ...raw("tok"), ...raw("1@x")], // unknown tag
			[2, 1, 3, 3, ...raw("tok"), 0, 2, 0xff, 0xfe], // invalid UTF-8
		]) {
			expect(decodeAgentHandle(forge(...bytes))).toBeNull();
		}
	});

	it("is what a reply command carries, after the task address", () => {
		const handle = encodeAgentHandle(AGENT);
		expect(agentReplyCommand({ target: { id: "t", seq: 9 }, fromProjectId: "p", quoted: "hi", agentHandle: handle })).toBe(
			`dev3 message --task seq:9 --agent ${handle} --subject "what your reply is about" "hi"`,
		);
	});
});
