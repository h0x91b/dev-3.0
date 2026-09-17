import { useCallback, useEffect, useRef, useState } from "react";
import type { Task } from "../../shared/types";
import {
	appendReviewComment,
	deleteReviewComment,
	markReviewCommentsSent,
	reopenReviewComment,
	resolveReviewComment,
	updateReviewCommentBody,
	type ReviewComment,
	type ReviewReplyAuthor,
} from "../../shared/review";
import { api } from "../rpc";
import { toast } from "../toast";

export interface TaskReviewApi {
	comments: ReviewComment[];
	add(comment: ReviewComment): void;
	update(commentId: string, body: string): void;
	remove(commentId: string): void;
	markSent(commentIds: Iterable<string>): void;
	resolve(commentId: string, by: ReviewReplyAuthor, reply?: string): void;
	reopen(commentId: string): void;
	clear(): void;
	/** One-shot import of comments a browser still held in localStorage. */
	importMany(comments: ReviewComment[]): void;
}

/**
 * The task's review comments, as the renderer sees them: the task record is the
 * source of truth, and every edit is applied locally first so the bubble reacts
 * on the click, then sent as its own RPC. A `taskUpdated` push — from this edit
 * or from an agent resolving a comment through the CLI — replaces the local copy.
 */
export function useTaskReview(task: Pick<Task, "id" | "review">, projectId: string): TaskReviewApi {
	const [comments, setComments] = useState<ReviewComment[]>(() => task.review ?? []);
	const serverRef = useRef(task.review);
	useEffect(() => {
		if (serverRef.current === task.review) return;
		serverRef.current = task.review;
		setComments(task.review ?? []);
	}, [task.review]);

	const taskId = task.id;
	const run = useCallback((request: Promise<unknown>) => {
		request.catch((err) => {
			toast.error(String(err), { taskId });
			setComments(serverRef.current ?? []);
		});
	}, [taskId]);

	const add = useCallback((comment: ReviewComment) => {
		setComments((current) => appendReviewComment(current, comment));
		run(api.request.addReviewComment({ taskId, projectId, comment }));
	}, [projectId, run, taskId]);

	const update = useCallback((commentId: string, body: string) => {
		setComments((current) => updateReviewCommentBody(current, commentId, body));
		run(api.request.updateReviewComment({ taskId, projectId, commentId, body }));
	}, [projectId, run, taskId]);

	const remove = useCallback((commentId: string) => {
		setComments((current) => deleteReviewComment(current, commentId));
		run(api.request.deleteReviewComment({ taskId, projectId, commentId }));
	}, [projectId, run, taskId]);

	const markSent = useCallback((commentIds: Iterable<string>) => {
		const ids = [...commentIds];
		if (ids.length === 0) return;
		setComments((current) => markReviewCommentsSent(current, ids));
		run(api.request.markReviewCommentsSent({ taskId, projectId, commentIds: ids }));
	}, [projectId, run, taskId]);

	const resolve = useCallback((commentId: string, by: ReviewReplyAuthor, reply?: string) => {
		setComments((current) => resolveReviewComment(current, commentId, by, reply));
		run(api.request.resolveReviewComment({ taskId, projectId, commentId, by, reply }));
	}, [projectId, run, taskId]);

	const reopen = useCallback((commentId: string) => {
		setComments((current) => reopenReviewComment(current, commentId));
		run(api.request.reopenReviewComment({ taskId, projectId, commentId }));
	}, [projectId, run, taskId]);

	const clear = useCallback(() => {
		setComments([]);
		run(api.request.clearTaskReview({ taskId, projectId }));
	}, [projectId, run, taskId]);

	const importMany = useCallback((imported: ReviewComment[]) => {
		if (imported.length === 0) return;
		setComments((current) => {
			const known = new Set(current.map((comment) => comment.id));
			return imported.filter((comment) => !known.has(comment.id)).reduce(appendReviewComment, current);
		});
		run(api.request.importReviewComments({ taskId, projectId, comments: imported }));
	}, [projectId, run, taskId]);

	return { comments, add, update, remove, markSent, resolve, reopen, clear, importMany };
}
