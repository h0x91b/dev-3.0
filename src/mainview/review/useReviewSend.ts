import { useCallback, useState } from "react";
import { buildReviewPrompt, type ReviewComment } from "../../shared/review";
import { api } from "../rpc";
import { toast } from "../toast";
import { useT } from "../i18n";
import type { TaskReviewApi } from "./useTaskReview";

/**
 * The one send path every review surface uses: prompt built from the shared
 * serializer, typed into the task's agent pane, comments marked sent — never
 * deleted (decision `never-destroy-a-review-on-send`).
 */
export function useReviewSend(taskId: string, projectId: string | undefined, review: TaskReviewApi) {
	const t = useT();
	const [sendingCommentIds, setSendingCommentIds] = useState<Record<string, boolean>>({});
	const [batchSending, setBatchSending] = useState(false);

	const sendComments = useCallback((comments: ReviewComment[], onDone?: () => void) => {
		if (!projectId || comments.length === 0) {
			onDone?.();
			return;
		}
		const text = buildReviewPrompt(comments.map((comment) => ({
			id: comment.id,
			anchor: comment.anchor,
			comment: comment.body,
			origin: "local",
			author: null,
		})));
		api.request.sendAgentMessageNow({ taskId, projectId, text })
			.then((result) => {
				review.markSent(comments.map((comment) => comment.id));
				toast.success(result?.spilledPath
					? t("infoPanel.diffReviewSendCommentSuccessFile", { path: result.spilledPath })
					: t("infoPanel.diffReviewSendCommentSuccess"), { taskId });
			})
			.catch((err) => {
				toast.error(t("infoPanel.diffReviewSendCommentFailed", { error: String(err) }), { taskId });
			})
			.finally(() => onDone?.());
	}, [projectId, review, t, taskId]);

	const sendOne = useCallback((comment: ReviewComment) => {
		if (sendingCommentIds[comment.id]) return;
		setSendingCommentIds((ids) => ({ ...ids, [comment.id]: true }));
		sendComments([comment], () => setSendingCommentIds((ids) => {
			const next = { ...ids };
			delete next[comment.id];
			return next;
		}));
	}, [sendComments, sendingCommentIds]);

	const sendAll = useCallback((comments: ReviewComment[]) => {
		if (batchSending || comments.length === 0) return;
		setBatchSending(true);
		sendComments(comments, () => setBatchSending(false));
	}, [batchSending, sendComments]);

	return { sendComments, sendOne, sendAll, sendingCommentIds, batchSending };
}
