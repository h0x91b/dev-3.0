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

/**
 * Every mutation resolves to whether the task record took it: `false` means the
 * RPC was refused and the local copy has been rolled back. Callers that destroy
 * the only other copy of a comment — or tell the user it is saved — must wait
 * for it; the rest may ignore it.
 */
export type ReviewMutation = Promise<boolean>;

export interface TaskReviewApi {
	comments: ReviewComment[];
	add(comment: ReviewComment): ReviewMutation;
	update(commentId: string, body: string): ReviewMutation;
	remove(commentId: string): ReviewMutation;
	markSent(commentIds: Iterable<string>): ReviewMutation;
	resolve(commentId: string, by: ReviewReplyAuthor, reply?: string): ReviewMutation;
	reopen(commentId: string): ReviewMutation;
	clear(): ReviewMutation;
	/** One-shot import of comments a browser still held in localStorage. */
	importMany(comments: ReviewComment[]): ReviewMutation;
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
	const run = useCallback((request: Promise<unknown>): ReviewMutation => {
		return request.then(() => true).catch((err) => {
			toast.error(String(err), { taskId });
			setComments(serverRef.current ?? []);
			return false;
		});
	}, [taskId]);

	const add = useCallback((comment: ReviewComment) => {
		setComments((current) => appendReviewComment(current, comment));
		return run(api.request.addReviewComment({ taskId, projectId, comment }));
	}, [projectId, run, taskId]);

	const update = useCallback((commentId: string, body: string) => {
		setComments((current) => updateReviewCommentBody(current, commentId, body));
		return run(api.request.updateReviewComment({ taskId, projectId, commentId, body }));
	}, [projectId, run, taskId]);

	const remove = useCallback((commentId: string) => {
		setComments((current) => deleteReviewComment(current, commentId));
		return run(api.request.deleteReviewComment({ taskId, projectId, commentId }));
	}, [projectId, run, taskId]);

	const markSent = useCallback((commentIds: Iterable<string>) => {
		const ids = [...commentIds];
		if (ids.length === 0) return Promise.resolve(true);
		setComments((current) => markReviewCommentsSent(current, ids));
		return run(api.request.markReviewCommentsSent({ taskId, projectId, commentIds: ids }));
	}, [projectId, run, taskId]);

	const resolve = useCallback((commentId: string, by: ReviewReplyAuthor, reply?: string) => {
		setComments((current) => resolveReviewComment(current, commentId, by, reply));
		return run(api.request.resolveReviewComment({ taskId, projectId, commentId, by, reply }));
	}, [projectId, run, taskId]);

	const reopen = useCallback((commentId: string) => {
		setComments((current) => reopenReviewComment(current, commentId));
		return run(api.request.reopenReviewComment({ taskId, projectId, commentId }));
	}, [projectId, run, taskId]);

	const clear = useCallback(() => {
		setComments([]);
		return run(api.request.clearTaskReview({ taskId, projectId }));
	}, [projectId, run, taskId]);

	const importMany = useCallback((imported: ReviewComment[]) => {
		if (imported.length === 0) return Promise.resolve(true);
		setComments((current) => {
			const known = new Set(current.map((comment) => comment.id));
			return imported.filter((comment) => !known.has(comment.id)).reduce(appendReviewComment, current);
		});
		return run(api.request.importReviewComments({ taskId, projectId, comments: imported }));
	}, [projectId, run, taskId]);

	return { comments, add, update, remove, markSent, resolve, reopen, clear, importMany };
}
