import { describe, expect, it, vi } from "vitest";

vi.mock("../../data", () => ({}));
vi.mock("../../preparation-runtime", () => ({ forgetTaskPreparation: vi.fn(), markTaskPreparationCancelled: vi.fn() }));
vi.mock("../../rpc-handlers/shared", () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("../executor", () => ({ executeLifecycleEffect: vi.fn(), launchLifecycleColumnAgent: vi.fn() }));

import { WorkspaceReclaimRefusedError } from "../../git";
import { isWorkspaceReclaimRefusal } from "../service";

// The refusal crosses the effect boundary as an Error; the compensating
// preparationFailed carries `preserveWorkspace` only when it is this one.
describe("isWorkspaceReclaimRefusal", () => {
	it("recognises the typed refusal, and nothing else", () => {
		expect(isWorkspaceReclaimRefusal(new WorkspaceReclaimRefusedError("unique-commits", { branch: "dev3/task-x", sha: "abc", commits: 2 }))).toBe(true);
		expect(isWorkspaceReclaimRefusal(new Error("Failed to create worktree"))).toBe(false);
		expect(isWorkspaceReclaimRefusal("WorkspaceReclaimRefusedError")).toBe(false);
	});

	it("names the leftover and says nothing was deleted", () => {
		const error = new WorkspaceReclaimRefusedError("unique-commits", { branch: "dev3/task-x", sha: "abc", commits: 2 });
		expect(error.message).toContain("branch dev3/task-x (tip abc)");
		expect(error.message).toContain("2 commit(s) found on no other branch");
		expect(error.message).toContain("Nothing was started or deleted");
	});
});

describe("errorEvent — the compensation a failed prepareTask dispatches", () => {
	it("marks preserveWorkspace for a reclaim refusal only", async () => {
		const { errorEvent } = await import("../service");
		const effect = {
			type: "prepareTask",
			onError: "abort",
			compensatingEvent: { type: "preparationFailed", runId: "r1", error: "x" },
		} as never;
		const refused = errorEvent(effect, new WorkspaceReclaimRefusedError("dirty-dir", { path: "/wt" }));
		expect(refused).toMatchObject({ type: "preparationFailed", compensating: true, preserveWorkspace: true });
		expect(errorEvent(effect, new Error("boom"))).not.toHaveProperty("preserveWorkspace");
	});
});
