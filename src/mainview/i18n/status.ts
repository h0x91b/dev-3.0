import type { TaskStatus } from "../../shared/types";
import type { TranslationKey } from "./translations/en";

const STATUS_KEY_MAP: Record<TaskStatus, TranslationKey> = {
	todo: "status.todo",
	"in-progress": "status.inProgress",
	"user-questions": "status.userQuestions",
	"review-by-ai": "status.reviewByAi",
	"review-by-user": "status.reviewByUser",
	"review-by-colleague": "status.reviewByColleague",
	completed: "status.completed",
	cancelled: "status.cancelled",
};

export function statusKey(status: TaskStatus): TranslationKey {
	return STATUS_KEY_MAP[status];
}
