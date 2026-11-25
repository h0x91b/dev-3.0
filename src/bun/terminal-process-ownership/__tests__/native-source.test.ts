import { describe, expect, it } from "vitest";
import { nativeOwnershipClaim } from "../native-source";

const record = { sessionId: "sess-1", host: { pid: 4100 }, shell: { pid: 4101 } };

describe("native ownership claim", () => {
	it("proves host and shell roots for an owned session", () => {
		const claim = nativeOwnershipClaim({ sessionId: "sess-1", record, verdict: "owned" });
		expect(claim.backend).toBe("native");
		expect(claim.proof.verified).toBe(true);
		expect(claim.roots).toEqual([
			{ pid: 4100, role: "host" },
			{ pid: 4101, role: "shell" },
		]);
	});

	it("reports an exited session as stale and a reused PID as reused, never as owned", () => {
		const claim = nativeOwnershipClaim({ sessionId: "sess-1", record, verdict: "dead" });
		expect(claim.proof).toEqual({
			verified: false,
			state: "stale",
			reason: "the recorded native host or shell process has exited",
		});
		expect(claim.roots).toEqual([]);

		const reused = nativeOwnershipClaim({ sessionId: "sess-1", record, verdict: "reused" });
		expect(reused.proof.verified).toBe(false);
		expect(reused.proof).toMatchObject({ state: "reused" });
		expect(reused.roots).toEqual([]);
	});

	it("is unavailable with a reason for a missing record, an unverified one, another session's, or one without a usable PID", () => {
		expect(nativeOwnershipClaim({ sessionId: "sess-1", record: null, verdict: "owned" }).proof).toEqual({
			verified: false,
			state: "unavailable",
			reason: "no native session record was found for this session",
		});
		expect(nativeOwnershipClaim({ sessionId: "sess-1", record }).proof).toMatchObject({
			state: "unavailable",
			reason: "native session ownership was not verified",
		});
		expect(nativeOwnershipClaim({ sessionId: "sess-2", record, verdict: "owned" }).proof).toMatchObject({
			state: "unavailable",
			reason: "the native session record belongs to a different session id",
		});
		const noPid = nativeOwnershipClaim({
			sessionId: "sess-1",
			record: { sessionId: "sess-1", host: { pid: 0 }, shell: {} },
			verdict: "owned",
		});
		expect(noPid.proof).toMatchObject({
			state: "unavailable",
			reason: "the native session record carried no usable host or shell PID",
		});
	});
});
