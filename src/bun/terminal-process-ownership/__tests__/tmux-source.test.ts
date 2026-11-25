import { describe, expect, it, vi } from "vitest";
import { tmuxOwnershipClaim, tmuxOwnershipClaimFromPanePids, type TmuxOwnershipPort } from "../tmux-source";

function fakePort(panes: Record<string, number[]>): TmuxOwnershipPort {
	return { panePids: async (sessionName) => panes[sessionName] ?? [] };
}

describe("tmux ownership claim", () => {
	it("treats every reported pane PID as a proved root, and no panes as unavailable", () => {
		const claim = tmuxOwnershipClaimFromPanePids("dev3-task-abc", [11, 12]);
		expect(claim.backend).toBe("tmux");
		expect(claim.proof.verified).toBe(true);
		expect(claim.roots).toEqual([
			{ pid: 11, role: "pane" },
			{ pid: 12, role: "pane" },
		]);

		const empty = tmuxOwnershipClaimFromPanePids("dev3-task-abc", []);
		expect(empty.proof).toEqual({
			verified: false,
			state: "unavailable",
			reason: "tmux reported no panes for this session",
		});
	});

	it("folds sibling sessions into one accounting unit, asking tmux only for the sessions it was given", async () => {
		const port = fakePort({ "dev3-task-abc": [11], "dev3-dev-abc": [21, 22], "dev3-other": [99] });
		const panePids = vi.fn(port.panePids);
		const claim = await tmuxOwnershipClaim("dev3-task-abc", ["dev3-task-abc", "dev3-dev-abc"], { panePids });
		expect(claim.roots.map((root) => root.pid)).toEqual([11, 21, 22]);
		expect(panePids.mock.calls).toEqual([["dev3-task-abc"], ["dev3-dev-abc"]]);
	});
});
