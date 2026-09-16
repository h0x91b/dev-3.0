import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Task } from "../../shared/types";
import type { ReviewComment } from "../../shared/review";

const pushMessage = vi.fn();
vi.mock("../rpc-handlers/shared", () => ({
	log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
	getPushMessage: () => pushMessage,
}));

let stored: Task;
const getProject = vi.fn();
const updateTaskWith = vi.fn();
vi.mock("../data", () => ({
	getProject: (...args: unknown[]) => getProject(...args),
	updateTaskWith: (...args: unknown[]) => updateTaskWith(...args),
}));

import { reviewCommentHandlers } from "../rpc-handlers/review-comments";

const project = { id: "p1", path: "/tmp/proj" };
const comment: ReviewComment = {
	id: "c1",
	body: "  Wrong number  ",
	createdAt: "2026-09-15T10:00:00.000Z",
	anchor: { kind: "artifact-element", artifactId: "a1", version: 1, title: "Report", selector: "h1", text: "Title", heading: null },
};

beforeEach(() => {
	vi.clearAllMocks();
	stored = { id: "t1", status: "in-progress" } as Task;
	getProject.mockResolvedValue(project);
	updateTaskWith.mockImplementation(async (_project: unknown, _taskId: string, mutator: (task: Task) => Promise<{ updates: Partial<Task> }>) => {
		const { updates } = await mutator(stored);
		stored = { ...stored, ...updates };
		return { task: stored, result: undefined };
	});
});

describe("review comment handlers", () => {
	it("appends a trimmed comment and pushes taskUpdated", async () => {
		const task = await reviewCommentHandlers.addReviewComment({ taskId: "t1", projectId: "p1", comment });
		expect(task.review).toHaveLength(1);
		expect(task.review?.[0].body).toBe("Wrong number");
		expect(pushMessage).toHaveBeenCalledWith("taskUpdated", { projectId: "p1", task });
	});

	it("rejects an empty body", async () => {
		await expect(reviewCommentHandlers.addReviewComment({ taskId: "t1", projectId: "p1", comment: { ...comment, body: "  " } }))
			.rejects.toThrow(/body is required/);
	});

	it("resolves with a reply, reopens, and clears", async () => {
		await reviewCommentHandlers.addReviewComment({ taskId: "t1", projectId: "p1", comment });
		let task = await reviewCommentHandlers.resolveReviewComment({ taskId: "t1", projectId: "p1", commentId: "c1", by: "agent", reply: "Fixed" });
		expect(task.review?.[0]).toMatchObject({ resolvedBy: "agent" });
		expect(task.review?.[0].replies?.[0]).toMatchObject({ author: "agent", body: "Fixed" });
		task = await reviewCommentHandlers.reopenReviewComment({ taskId: "t1", projectId: "p1", commentId: "c1" });
		expect(task.review?.[0].resolvedAt).toBeUndefined();
		task = await reviewCommentHandlers.clearTaskReview({ taskId: "t1", projectId: "p1" });
		expect(task.review).toEqual([]);
	});

	it("imports only unknown comments", async () => {
		await reviewCommentHandlers.addReviewComment({ taskId: "t1", projectId: "p1", comment });
		const task = await reviewCommentHandlers.importReviewComments({
			taskId: "t1",
			projectId: "p1",
			comments: [comment, { ...comment, id: "c2", body: "Another" }, { ...comment, id: "c3", body: "   " }],
		});
		expect(task.review?.map((c) => c.id)).toEqual(["c1", "c2"]);
	});

	it("marks sent and deletes", async () => {
		await reviewCommentHandlers.addReviewComment({ taskId: "t1", projectId: "p1", comment });
		let task = await reviewCommentHandlers.markReviewCommentsSent({ taskId: "t1", projectId: "p1", commentIds: ["c1"] });
		expect(task.review?.[0].sentAt).toBeTruthy();
		task = await reviewCommentHandlers.deleteReviewComment({ taskId: "t1", projectId: "p1", commentId: "c1" });
		expect(task.review).toEqual([]);
	});
});
