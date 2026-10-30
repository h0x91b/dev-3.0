import { describe, expect, it } from "vitest";
import { isTaskSoundEnabled, isTaskSoundStatus } from "../../shared/task-sound-statuses";
import type { TaskStatus } from "../../shared/types";

describe("task sound statuses", () => {
	it("names exactly the columns that can chime", () => {
		const all: TaskStatus[] = [
			"todo", "in-progress", "user-questions", "review-by-ai",
			"review-by-user", "review-by-colleague", "completed", "cancelled",
		];
		expect(all.filter(isTaskSoundStatus)).toEqual(["user-questions", "review-by-user", "completed", "cancelled"]);
	});

	it("keeps both chimes on unless explicitly turned off", () => {
		expect(isTaskSoundEnabled({}, "completed")).toBe(true);
		expect(isTaskSoundEnabled({}, "review-by-user")).toBe(true);
		expect(isTaskSoundEnabled({}, "user-questions")).toBe(true);
		expect(isTaskSoundEnabled({ playSoundOnTaskComplete: false }, "cancelled")).toBe(false);
		expect(isTaskSoundEnabled({ playSoundOnTaskNeedsYou: false }, "user-questions")).toBe(false);
		expect(isTaskSoundEnabled({ playSoundOnTaskComplete: false, playSoundOnTaskNeedsYou: true }, "user-questions")).toBe(true);
	});
});
