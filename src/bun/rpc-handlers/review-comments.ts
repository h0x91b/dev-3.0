import type { Task } from "../../shared/types";
import {
	appendReviewComment,
	deleteReviewComment as deleteComment,
	markReviewCommentsSent as markSent,
	reopenReviewComment as reopen,
	replyToReviewComment,
	resolveReviewComment as resolve,
	updateReviewCommentBody,
	type ReviewComment,
	type ReviewReplyAuthor,
} from "../../shared/review";
import * as data from "../data";
import { getPushMessage, log } from "./shared";

/**
 * Review comments live on the task record (`Task.review`). Every handler
 * recomputes the list from the CURRENT task inside the per-task lock, so a
 * renderer edit and an agent's `dev3 review resolve` never overwrite each other.
 */
async function mutateReview(
	params: { taskId: string; projectId: string },
	name: string,
	mutate: (current: ReviewComment[] | undefined) => ReviewComment[],
): Promise<Task> {
	log.info(`→ ${name}`, { taskId: params.taskId });
	const project = await data.getProject(params.projectId);
	const { task } = await data.updateTaskWith(project, params.taskId, async (current) => ({
		updates: { review: mutate(current.review) },
		result: undefined,
	}));
	getPushMessage()?.("taskUpdated", { projectId: project.id, task });
	return task;
}

async function addReviewComment(params: { taskId: string; projectId: string; comment: ReviewComment }): Promise<Task> {
	const body = params.comment.body.trim();
	if (!body) throw new Error("Review comment body is required");
	return mutateReview(params, "addReviewComment", (current) => appendReviewComment(current, { ...params.comment, body }));
}

async function updateReviewComment(params: { taskId: string; projectId: string; commentId: string; body: string }): Promise<Task> {
	const body = params.body.trim();
	if (!body) throw new Error("Review comment body is required");
	return mutateReview(params, "updateReviewComment", (current) => updateReviewCommentBody(current, params.commentId, body));
}

async function deleteReviewComment(params: { taskId: string; projectId: string; commentId: string }): Promise<Task> {
	return mutateReview(params, "deleteReviewComment", (current) => deleteComment(current, params.commentId));
}

async function markReviewCommentsSent(params: { taskId: string; projectId: string; commentIds: string[] }): Promise<Task> {
	return mutateReview(params, "markReviewCommentsSent", (current) => markSent(current, params.commentIds));
}

async function resolveReviewComment(params: { taskId: string; projectId: string; commentId: string; by: ReviewReplyAuthor; reply?: string }): Promise<Task> {
	return mutateReview(params, "resolveReviewComment", (current) => resolve(current, params.commentId, params.by, params.reply?.trim() || undefined));
}

async function reopenReviewComment(params: { taskId: string; projectId: string; commentId: string }): Promise<Task> {
	return mutateReview(params, "reopenReviewComment", (current) => reopen(current, params.commentId));
}

async function replyReviewComment(params: { taskId: string; projectId: string; commentId: string; body: string; author: ReviewReplyAuthor }): Promise<Task> {
	const body = params.body.trim();
	if (!body) throw new Error("Reply body is required");
	return mutateReview(params, "replyReviewComment", (current) => replyToReviewComment(current, params.commentId, { body, author: params.author }));
}

async function clearTaskReview(params: { taskId: string; projectId: string }): Promise<Task> {
	return mutateReview(params, "clearTaskReview", () => []);
}

async function importReviewComments(params: { taskId: string; projectId: string; comments: ReviewComment[] }): Promise<Task> {
	return mutateReview(params, "importReviewComments", (current) => {
		const known = new Set((current ?? []).map((comment) => comment.id));
		let next = current ?? [];
		for (const comment of params.comments) {
			if (known.has(comment.id) || !comment.body.trim()) continue;
			next = appendReviewComment(next, comment);
		}
		return next;
	});
}

export const reviewCommentHandlers = {
	addReviewComment,
	updateReviewComment,
	deleteReviewComment,
	markReviewCommentsSent,
	resolveReviewComment,
	reopenReviewComment,
	replyReviewComment,
	clearTaskReview,
	importReviewComments,
};
