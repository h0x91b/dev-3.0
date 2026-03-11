import { statusKey } from "../status";
import type { TaskStatus } from "../../../shared/types";

describe("statusKey", () => {
	const expected: Record<TaskStatus, string> = {
		todo: "status.todo",
		"in-progress": "status.inProgress",
		"user-questions": "status.userQuestions",
		"review-by-ai": "status.reviewByAi",
		"review-by-user": "status.reviewByUser",
		"review-by-colleague": "status.reviewByColleague",
		completed: "status.completed",
		cancelled: "status.cancelled",
	};

	for (const [status, key] of Object.entries(expected)) {
		it(`maps "${status}" to "${key}"`, () => {
			expect(statusKey(status as TaskStatus)).toBe(key);
		});
	}
});
