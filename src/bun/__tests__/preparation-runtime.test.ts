import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../logger", () => ({
	createLogger: () => ({
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	}),
}));

import {
	createTaskPreparation,
	finishTaskPreparation,
	forgetTaskPreparation,
	getTaskPreparationSnapshot,
	markTaskPreparationCancelled,
	registerPreparationSpawn,
} from "../preparation-runtime";

const TASK_ID = "late-process-task";

afterEach(() => {
	forgetTaskPreparation(TASK_ID);
});

describe("preparation cancellation barrier", () => {
	it("waits for a process registered after cancellation to exit", async () => {
		let finishProcess!: (code: number) => void;
		const exited = new Promise<number>((resolve) => { finishProcess = resolve; });
		const { runId } = createTaskPreparation(TASK_ID, "test");
		const cancellation = markTaskPreparationCancelled(TASK_ID);

		const registration = registerPreparationSpawn(
			TASK_ID,
			123,
			["git", "worktree", "add"],
			exited,
		);
		finishTaskPreparation(TASK_ID, runId);
		let settled = false;
		void cancellation.settled.then(() => { settled = true; });
		await Promise.resolve();

		expect(registration).toMatchObject({ runId, cancelled: true });
		expect(getTaskPreparationSnapshot(TASK_ID)).toMatchObject({
			cancelled: true,
			pids: [123],
		});
		expect(settled).toBe(false);

		finishProcess(137);
		await cancellation.settled;
		expect(getTaskPreparationSnapshot(TASK_ID)).toBeNull();
	});
});
