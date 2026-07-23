import { useState } from "react";
import type { PRReviewThread, TaskPRCommentsPayload } from "../../../shared/types";
import { useT } from "../../i18n";
import HelpSpot from "../HelpSpot";
import { CommentMarkdown } from "./markdown";
import { formatCommentTimestamp, GithubThreadView, type ThreadSendState } from "./GithubThreadView";

const NERD_FONT = "'JetBrainsMono Nerd Font Mono'";
const GITHUB_GLYPH = "\uf09b";
const EXTERNAL_LINK_GLYPH = "\uf08e";
const REFRESH_GLYPH = "\uf021";

export interface GithubThreadActions {
	exportSelection: Record<string, boolean>;
	onToggleExport: (threadId: string) => void;
	onSendToAgent: (thread: PRReviewThread) => void;
	sendStates: Record<string, ThreadSendState>;
	registerRef?: (id: string, element: HTMLDivElement | null) => void;
}

/**
 * The GitHub layer's one control cluster: a collapsible "Conversation (N)"
 * strip at the top of the diff stream. Hosts the top-level PR comments, the
 * show-resolved toggle, refresh, the fetched-at stamp, and (branch mode) the
 * group of threads on files absent from the current diff. Read-only — every
 * item links out to GitHub.
 */
export function PrConversationBlock({
	payload,
	refreshing,
	error,
	onRefresh,
	showResolved,
	onToggleShowResolved,
	unmappedThreads,
	threadActions,
	diffMode,
	onSwitchToBranchDiff,
}: {
	payload: TaskPRCommentsPayload | null;
	refreshing: boolean;
	error: string | null;
	onRefresh: () => void;
	showResolved: boolean;
	onToggleShowResolved: () => void;
	/** Branch mode: threads on files absent from the rendered diff (already resolved-filtered). */
	unmappedThreads: Array<{ path: string; threads: PRReviewThread[] }>;
	threadActions: GithubThreadActions;
	diffMode: string;
	onSwitchToBranchDiff: () => void;
}) {
	const t = useT();
	const [expanded, setExpanded] = useState(false);
	const [unmappedOpen, setUnmappedOpen] = useState(false);

	if (!payload && !error && !refreshing) {
		return null;
	}

	const conversation = payload?.conversation ?? [];
	const threads = payload?.threads ?? [];
	const unresolvedCount = threads.filter((thread) => !thread.isResolved).length;
	const resolvedCount = threads.length - unresolvedCount;
	const unmappedCount = unmappedThreads.reduce((sum, group) => sum + group.threads.length, 0);
	const toggleExpanded = () => setExpanded((current) => !current);

	return (
		<div className="mb-4 rounded-xl border border-edge bg-raised" data-testid="pr-conversation-block">
			<div className="flex flex-wrap items-center gap-2 px-4 py-2.5">
				<button
					type="button"
					onClick={toggleExpanded}
					aria-expanded={expanded}
					data-testid="pr-conversation-toggle"
					className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md text-left transition-colors hover:bg-raised-hover hover:text-fg"
				>
					<span aria-hidden="true" className="text-[1rem] leading-none text-fg-2" style={{ fontFamily: NERD_FONT }}>
						{GITHUB_GLYPH}
					</span>
					<span className="text-xs font-semibold text-fg">{t("infoPanel.prConversationTitle")}</span>
					<span className="rounded bg-base px-1.5 py-px font-mono text-[0.6875rem] text-fg-3">{conversation.length}</span>
					<span aria-hidden="true" className="text-[0.8rem] text-fg-3">{expanded ? "▾" : "▸"}</span>
					{unresolvedCount > 0 && (
						<span className="rounded border border-warning/30 bg-warning/10 px-1.5 py-px text-[0.6875rem] font-semibold text-warning">
							{t.plural("infoPanel.prUnresolvedCount", unresolvedCount)}
						</span>
					)}
					<span className="flex-1" />
					{payload && (
						<span className="text-[0.6875rem] text-fg-muted" title={payload.fetchedAt}>
							{t("infoPanel.prFetchedAt", { time: formatCommentTimestamp(payload.fetchedAt) })}
						</span>
					)}
				</button>

				<HelpSpot topicId="diff.github-review" />

				{resolvedCount > 0 && (
					<button
						type="button"
						onClick={onToggleShowResolved}
						aria-pressed={showResolved}
						data-testid="pr-show-resolved-toggle"
						className={`inline-flex h-6 items-center gap-1.5 rounded-md border px-2 text-[0.6875rem] font-semibold transition-colors ${
							showResolved
								? "border-accent/40 bg-accent/15 text-accent"
								: "border-edge bg-base text-fg-2 hover:bg-elevated-hover"
						}`}
					>
						{t("infoPanel.prShowResolved", { count: String(resolvedCount) })}
					</button>
				)}

				<button
					type="button"
					onClick={onRefresh}
					disabled={refreshing}
					aria-label={t("infoPanel.prRefresh")}
					title={t("infoPanel.prRefresh")}
					data-testid="pr-comments-refresh"
					className="inline-flex h-6 w-6 items-center justify-center rounded-md border border-edge bg-base text-fg-2 transition-colors hover:bg-elevated-hover disabled:cursor-not-allowed disabled:text-fg-muted"
				>
					<span
						aria-hidden="true"
						className={`text-[0.75rem] leading-none${refreshing ? " animate-spin" : ""}`}
						style={{ fontFamily: NERD_FONT }}
					>
						{REFRESH_GLYPH}
					</span>
				</button>

				{payload && (
					<a
						href={payload.prUrl}
						target="_blank"
						rel="noreferrer"
						aria-label={t("infoPanel.prOpenOnGithub")}
						title={t("infoPanel.prOpenOnGithub")}
						className="inline-flex h-6 w-6 items-center justify-center rounded-md border border-edge bg-base text-fg-2 transition-colors hover:bg-elevated-hover hover:text-accent"
					>
						<span aria-hidden="true" className="text-[0.75rem] leading-none" style={{ fontFamily: NERD_FONT }}>
							{EXTERNAL_LINK_GLYPH}
						</span>
					</a>
				)}
			</div>

			{error && (
				<div className="flex flex-wrap items-center gap-2 border-t border-edge px-4 py-2 text-xs text-danger" data-testid="pr-comments-error">
					<span className="min-w-0 flex-1 break-words">{t("infoPanel.prCommentsError", { error })}</span>
					<button
						type="button"
						onClick={onRefresh}
						className="inline-flex h-6 items-center rounded-md border border-edge bg-base px-2 text-[0.6875rem] font-semibold text-fg-2 transition-colors hover:bg-elevated-hover"
					>
						{t("infoPanel.prRetry")}
					</button>
				</div>
			)}

			{threads.length > 0 && diffMode !== "branch" && (
				<div className="flex flex-wrap items-center gap-2 border-t border-edge px-4 py-2 text-xs text-fg-3" data-testid="pr-threads-mode-hint">
					<span>{t.plural("infoPanel.prThreadsHint", threads.length)}</span>
					<button
						type="button"
						onClick={onSwitchToBranchDiff}
						className="text-accent transition-colors hover:text-accent-hover"
					>
						{t("infoPanel.prThreadsHintButton")}
					</button>
				</div>
			)}

			{expanded && (
				<div className="border-t border-edge px-4 py-3 space-y-2" data-testid="pr-conversation-list">
					{conversation.length === 0 ? (
						<div className="text-xs text-fg-3">{t("infoPanel.prConversationEmpty")}</div>
					) : (
						conversation.map((comment) => (
							<div key={comment.id} className="rounded-lg border border-edge bg-base/60 px-3 py-2 space-y-1.5">
								<div className="flex flex-wrap items-center gap-2">
									<span className="text-xs font-semibold text-fg streamer-private">{comment.author ?? t("infoPanel.prUnknownAuthor")}</span>
									{comment.isBot && (
										<span className="rounded border border-edge bg-raised px-1 py-px text-[0.625rem] font-semibold uppercase tracking-wide text-fg-3">
											{t("infoPanel.prBotBadge")}
										</span>
									)}
									<span className="text-[0.6875rem] text-fg-muted">{formatCommentTimestamp(comment.createdAt)}</span>
									<span className="flex-1" />
									<a
										href={comment.url}
										target="_blank"
										rel="noreferrer"
										aria-label={t("infoPanel.prOpenOnGithub")}
										title={t("infoPanel.prOpenOnGithub")}
										className="inline-flex h-5 w-5 items-center justify-center rounded text-fg-3 transition-colors hover:bg-elevated-hover hover:text-accent"
									>
										<span aria-hidden="true" className="text-[0.8rem] leading-none" style={{ fontFamily: NERD_FONT }}>
											{EXTERNAL_LINK_GLYPH}
										</span>
									</a>
								</div>
								<CommentMarkdown body={comment.body} />
							</div>
						))
					)}
				</div>
			)}

			{unmappedCount > 0 && (
				<div className="border-t border-edge" data-testid="pr-unmapped-group">
					<button
						type="button"
						onClick={() => setUnmappedOpen((current) => !current)}
						aria-expanded={unmappedOpen}
						className="flex w-full items-center gap-2 px-4 py-2 text-left text-[0.6875rem] font-semibold uppercase tracking-[0.08em] text-fg-3 transition-colors hover:bg-elevated-hover"
					>
						<span aria-hidden="true">{unmappedOpen ? "▾" : "▸"}</span>
						<span>{t("infoPanel.prUnmappedGroup")}</span>
						<span className="rounded bg-base px-1.5 py-px font-mono text-[0.625rem] text-fg-3">{unmappedCount}</span>
					</button>
					{unmappedOpen && unmappedThreads.map((group) => (
						<div key={group.path}>
							<div className="px-4 pt-2 font-mono text-[0.6875rem] text-fg-3">{group.path}</div>
							{group.threads.map((thread) => (
								<GithubThreadView
									key={thread.id}
									thread={thread}
									exportSelected={!!threadActions.exportSelection[thread.id]}
									onToggleExport={threadActions.onToggleExport}
									onSendToAgent={threadActions.onSendToAgent}
									sendState={threadActions.sendStates[thread.id]}
									registerRef={threadActions.registerRef}
								/>
							))}
						</div>
					))}
				</div>
			)}
		</div>
	);
}
