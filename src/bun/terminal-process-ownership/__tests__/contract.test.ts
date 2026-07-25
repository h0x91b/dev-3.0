import { describe, expect, it } from "vitest";
import { isOwnablePid, unprovedClaim, verifiedClaim } from "../contract";

describe("ownership claim construction", () => {
	it("accepts only positive integer PIDs as ownable", () => {
		expect(isOwnablePid(1)).toBe(true);
		expect(isOwnablePid(0)).toBe(false);
		expect(isOwnablePid(-5)).toBe(false);
		expect(isOwnablePid(12.5)).toBe(false);
		expect(isOwnablePid("300")).toBe(false);
		expect(isOwnablePid(undefined)).toBe(false);
	});

	it("keeps proved roots, dropping duplicates and unusable PIDs", () => {
		const claim = verifiedClaim("tmux", "dev3-task-abc", [
			{ pid: 100, role: "pane" },
			{ pid: 100, role: "pane" },
			{ pid: 0, role: "pane" },
			{ pid: 200, role: "pane" },
		]);
		expect(claim.proof.verified).toBe(true);
		expect(claim.roots).toEqual([
			{ pid: 100, role: "pane" },
			{ pid: 200, role: "pane" },
		]);
	});

	it("degrades a root-less verified claim to unavailable instead of empty-owned", () => {
		const claim = verifiedClaim("native", "sess-1", [{ pid: -1, role: "host" }]);
		expect(claim.proof).toEqual({
			verified: false,
			state: "unavailable",
			reason: "no usable root process was proved for this session",
		});
		expect(claim.roots).toEqual([]);
	});

	it("carries the unproved state and reason verbatim", () => {
		const claim = unprovedClaim("native", "sess-1", "reused", "pid 42 is not ours");
		expect(claim).toEqual({
			backend: "native",
			sessionId: "sess-1",
			roots: [],
			proof: { verified: false, state: "reused", reason: "pid 42 is not ours" },
		});
	});
});
