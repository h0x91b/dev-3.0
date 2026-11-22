import { useCallback, useRef, useState } from "react";
import { buildReviewPrompt, type ReviewComment } from "../../shared/review";
import { heldBehindPrompt } from "../../shared/agent-prompt-delivery";
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
				// Held behind the agent's open prompt: the host's toast says so instead.
				if (!heldBehindPrompt(result)) toast.success(result?.spilledPath
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

	const replyingIds = useRef(new Set<string>());

	/**
	 * Answers the agent inside a thread: the whole thread goes to the agent first,
	 * and the reply is stored only once delivery is not refused — a failed send
	 * keeps the draft and leaves no reply the agent never saw. Never resolves,
	 * never touches `sentAt`. Resolves to whether the text left dev3.
	 */
	const sendReply = useCallback(async (comment: ReviewComment, body: string): Promise<boolean> => {
		const trimmed = body.trim();
		if (!projectId || !trimmed || replyingIds.current.has(comment.id)) return false;
		replyingIds.current.add(comment.id);
		try {
			const text = buildReviewPrompt([{
				id: comment.id,
				anchor: comment.anchor,
				comment: comment.body,
				origin: "local",
				author: null,
				replies: [...(comment.replies ?? []), { author: "user", body: trimmed }],
			}]);
			let spilledPath: string | null = null;
			let held = false;
			try {
				const result = await api.request.sendAgentMessageNow({ taskId, projectId, text });
				spilledPath = result?.spilledPath ?? null;
				held = heldBehindPrompt(result);
			} catch (err) {
				toast.error(t("infoPanel.diffReviewReplyFailed", { error: String(err) }), { taskId });
				return false;
			}
			await review.reply(comment.id, trimmed);
			if (!held) toast.success(spilledPath
				? t("infoPanel.diffReviewSendCommentSuccessFile", { path: spilledPath })
				: t("infoPanel.diffReviewReplySent"), { taskId });
			return true;
		} finally {
			replyingIds.current.delete(comment.id);
		}
	}, [projectId, review, t, taskId]);

	return { sendComments, sendOne, sendAll, sendReply, sendingCommentIds, batchSending };
}
