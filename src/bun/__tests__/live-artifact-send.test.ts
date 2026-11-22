import { describe, expect, it, vi } from "vitest";
import { runLiveOp } from "../live-artifact-ops";
import type { Project, Task } from "../../shared/types";

const project = { id: "p1" } as Project;
const task = { id: "t1", status: "in-progress" } as Task;

describe("live page send", () => {
	it("tells the page a send waits behind the agent's open prompt", async () => {
		const send = vi.fn(async () => ({ status: "held", reason: "behind-prompt" }));
		await expect(runLiveOp(project, task, "send", { text: "go" }, send)).resolves.toEqual({ sent: true, held: true });
	});

	it("keeps the plain answer for a send that went in", async () => {
		const send = vi.fn(async () => ({ status: "delivered" }));
		await expect(runLiveOp(project, task, "send", { text: "go" }, send)).resolves.toEqual({ sent: true });
	});
});
