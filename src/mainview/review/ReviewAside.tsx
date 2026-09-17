import { useState, type ReactNode } from "react";
import type { ReviewComment } from "../../shared/review";
import { useT } from "../i18n";
import { ReviewComposer } from "./ReviewComposer";
import { ReviewThreadView } from "./ReviewThreadView";
import type { TaskReviewApi } from "./useTaskReview";
import type { useReviewSend } from "./useReviewSend";

const ICON = "'JetBrainsMono Nerd Font Mono'";

export interface ReviewAsideProps {
	/** The comments this surface shows — already filtered to its own anchors. */
	comments: ReviewComment[];
	review: TaskReviewApi;
	send: ReturnType<typeof useReviewSend>;
	/** One line per comment: where it points, worded for the surface. */
	labelFor: (comment: ReviewComment, index: number) => string;
	/** Ids the surface could not place any more (a republished artifact, a changed file). */
	outdatedIds?: ReadonlySet<string>;
	activeCommentId: string | null;
	onActivate: (commentId: string) => void;
	/** A pick waiting for text: the composer renders above the list with this label. */
	pendingLabel: string | null;
	onSubmitPick: (body: string, andSend: boolean) => void;
	onCancelPick: () => void;
	hint: string;
	empty: string;
	/** Extra content under the header, e.g. a caption strip. */
	children?: ReactNode;
	testId?: string;
}

/**
 * The review column every non-diff surface opens beside its content: header
 * with count and the one batch send, the composer when a pick is pending, then
 * the thread bubbles. One component, so the artifact viewer, the image viewer
 * and the file preview cannot drift apart.
 */
export function ReviewAside({
	comments,
	review,
	send,
	labelFor,
	outdatedIds,
	activeCommentId,
	onActivate,
	pendingLabel,
	onSubmitPick,
	onCancelPick,
	hint,
	empty,
	children,
	testId = "review-aside",
}: ReviewAsideProps) {
	const t = useT();
	const [editingCommentId, setEditingCommentId] = useState<string | null>(null);
	const unsent = comments.filter((comment) => !comment.sentAt && !comment.resolvedAt);

	return (
		<aside
			data-testid={testId}
			aria-label={t("artifactViewer.reviewTitle")}
			className="flex w-[22rem] max-w-[45%] flex-shrink-0 flex-col border-l border-edge bg-raised"
		>
			<div className="flex items-center gap-2 border-b border-edge px-3 py-2">
				<span className="text-micro font-semibold uppercase tracking-wider text-fg-muted">{t("artifactViewer.reviewTitle")}</span>
				{comments.length > 0 && (
					<span data-testid={`${testId}-count`} className="font-mono text-micro text-fg-3">{comments.length}</span>
				)}
				{unsent.length > 0 && (
					<button
						type="button"
						data-testid={`${testId}-send-all`}
						disabled={send.batchSending}
						onClick={() => send.sendAll(unsent)}
						className="ml-auto inline-flex h-7 items-center gap-1.5 rounded-md border border-edge bg-base px-2 text-micro font-semibold text-fg-2 transition-colors hover:bg-elevated-hover disabled:cursor-not-allowed disabled:text-fg-muted"
					>
						<span aria-hidden="true" className="text-sm-plus leading-none" style={{ fontFamily: ICON }}>{""}</span>
						<span>{send.batchSending ? t("infoPanel.diffReviewExportSendSending") : t.plural("artifactViewer.reviewSendAll", unsent.length)}</span>
					</button>
				)}
			</div>
			{children}
			<div className="min-h-0 flex-1 overflow-y-auto">
				{!pendingLabel && <p className="px-3 py-2 text-micro leading-snug text-fg-3">{hint}</p>}
				{pendingLabel && (
					<div data-testid={`${testId}-composer`} className="border-b border-edge">
						<ReviewComposer
							anchorLabel={pendingLabel}
							onCancel={onCancelPick}
							onSubmit={(body) => onSubmitPick(body, false)}
							onSubmitAndSend={(body) => onSubmitPick(body, true)}
						/>
					</div>
				)}
				{comments.length === 0 && !pendingLabel && (
					<p className="px-3 py-2 text-micro text-fg-muted">{empty}</p>
				)}
				{comments.map((comment, i) => {
					const outdated = outdatedIds?.has(comment.id) ?? false;
					return (
						<div
							key={comment.id}
							data-testid={`${testId}-thread`}
							data-outdated={outdated ? "true" : undefined}
							className={comment.id === activeCommentId ? "bg-accent/5" : ""}
							onClick={() => onActivate(comment.id)}
						>
							<ReviewThreadView
								comments={[comment]}
								label={`${labelFor(comment, i)}${outdated ? ` · ${t("artifactViewer.reviewOutdated")}` : ""}`}
								registerCommentRef={() => {}}
								editingCommentId={editingCommentId}
								onStartEdit={setEditingCommentId}
								onCancelEdit={() => setEditingCommentId(null)}
								onSaveEdit={(id, body) => {
									const trimmed = body.trim();
									if (trimmed) review.update(id, trimmed);
									setEditingCommentId(null);
								}}
								onDeleteComment={(id) => { review.remove(id); setEditingCommentId(null); }}
								onSendComment={(id) => {
									const target = comments.find((item) => item.id === id);
									if (target) send.sendOne(target);
								}}
								onReopenComment={review.reopen}
								sendingCommentIds={send.sendingCommentIds}
							/>
						</div>
					);
				})}
			</div>
		</aside>
	);
}
