import { describe, expect, it, vi } from "vitest";
import { tmuxOwnershipClaim, tmuxOwnershipClaimFromPanePids, type TmuxOwnershipPort } from "../tmux-source";

function fakePort(panes: Record<string, number[]>): TmuxOwnershipPort {
	return { panePids: async (sessionName) => panes[sessionName] ?? [] };
}

describe("tmux ownership claim", () => {
	it("treats every reported pane PID as a proved root", () => {
		const claim = tmuxOwnershipClaimFromPanePids("dev3-task-abc", [11, 12]);
		expect(claim.backend).toBe("tmux");
		expect(claim.proof.verified).toBe(true);
		expect(claim.roots).toEqual([
			{ pid: 11, role: "pane" },
			{ pid: 12, role: "pane" },
		]);
	});

	it("is unavailable when tmux reports no panes for the session", () => {
		const claim = tmuxOwnershipClaimFromPanePids("dev3-task-abc", []);
		expect(claim.proof).toEqual({
			verified: false,
			state: "unavailable",
			reason: "tmux reported no panes for this session",
		});
	});

	it("folds sibling sessions into one accounting unit", async () => {
		const claim = await tmuxOwnershipClaim(
			"dev3-task-abc",
			["dev3-task-abc", "dev3-dev-abc"],
			fakePort({ "dev3-task-abc": [11], "dev3-dev-abc": [21, 22] }),
		);
		expect(claim.roots.map((root) => root.pid)).toEqual([11, 21, 22]);
	});

	it("asks tmux only for the sessions it was given", async () => {
		const panePids = vi.fn(async () => [11]);
		await tmuxOwnershipClaim("dev3-task-abc", ["dev3-task-abc"], { panePids });
		expect(panePids.mock.calls).toEqual([["dev3-task-abc"]]);
	});
});
