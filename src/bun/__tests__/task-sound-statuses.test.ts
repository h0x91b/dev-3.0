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

	it("keeps the completion chime opt-out and the needs-you chime opt-in", () => {
		expect(isTaskSoundEnabled({}, "completed")).toBe(true);
		expect(isTaskSoundEnabled({}, "review-by-user")).toBe(false);
		expect(isTaskSoundEnabled({ playSoundOnTaskComplete: false }, "cancelled")).toBe(false);
		expect(isTaskSoundEnabled({ playSoundOnTaskComplete: false, playSoundOnTaskNeedsYou: true }, "user-questions")).toBe(true);
		expect(isTaskSoundEnabled({ playSoundOnTaskNeedsYou: true }, "completed")).toBe(true);
	});
});
