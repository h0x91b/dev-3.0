import type { PRReviewComment, PRReviewThread } from "../../../shared/types";
import { useT } from "../../i18n";
import { CommentMarkdown } from "./markdown";

const NERD_FONT = "'JetBrainsMono Nerd Font Mono'";
const GITHUB_GLYPH = "\uf09b";
const EXTERNAL_LINK_GLYPH = "\uf08e";
const TERMINAL_GLYPH = "\uf120";

export type ThreadSendState = "sending" | "sent" | undefined;

export function formatCommentTimestamp(iso: string): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) {
		return "";
	}
	return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function CommentBubble({ comment }: { comment: PRReviewComment }) {
	const t = useT();
	return (
		<div className="dev3-inline-comment__bubble rounded-lg border border-edge bg-raised px-3 py-2 space-y-1.5">
			<div className="flex flex-wrap items-center gap-2">
				<span className="text-xs font-semibold text-fg">{comment.author ?? t("infoPanel.prUnknownAuthor")}</span>
				{comment.isBot && (
					<span className="rounded border border-edge bg-base px-1 py-px text-[0.625rem] font-semibold uppercase tracking-wide text-fg-3">
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
	);
}

export function GithubThreadView({
	thread,
	exportSelected,
	onToggleExport,
	onSendToAgent,
	sendState,
	registerRef,
}: {
	thread: PRReviewThread;
	exportSelected: boolean;
	onToggleExport: (threadId: string) => void;
	onSendToAgent: (thread: PRReviewThread) => void;
	sendState: ThreadSendState;
	/** Registers the thread container for scroll-to from the review export card. */
	registerRef?: (id: string, element: HTMLDivElement | null) => void;
}) {
	const t = useT();
	const line = thread.line ?? thread.originalLine;
	return (
		<div
			ref={(element) => registerRef?.(thread.id, element)}
			className={`dev3-inline-comment dev3-github-thread scroll-mt-24 border-t border-edge bg-base/75 px-4 py-3 space-y-2${thread.isResolved ? " opacity-75" : ""}`}
			data-testid="github-thread"
			data-thread-id={thread.id}
		>
			<div className="flex flex-wrap items-center gap-2">
				<span aria-hidden="true" className="text-[0.9rem] leading-none text-fg-2" style={{ fontFamily: NERD_FONT }}>
					{GITHUB_GLYPH}
				</span>
				<span className="dev3-inline-comment__meta text-[0.6875rem] font-semibold uppercase tracking-[0.08em] text-fg-muted">
					{t("infoPanel.prReviewThread")}
					{line !== null ? ` · ${thread.path.split("/").pop()}:${line}` : ""}
				</span>
				{thread.isResolved && (
					<span className="rounded border border-success/30 bg-success/10 px-1.5 py-px text-[0.625rem] font-semibold text-success">
						{t("infoPanel.prResolvedBadge")}
					</span>
				)}
				{thread.isOutdated && (
					<span className="rounded border border-warning/30 bg-warning/10 px-1.5 py-px text-[0.625rem] font-semibold text-warning">
						{t("infoPanel.prOutdatedBadge")}
					</span>
				)}
			</div>

			{thread.comments.map((comment) => (
				<CommentBubble key={comment.id} comment={comment} />
			))}

			<div className="flex flex-wrap items-center justify-end gap-2">
				<button
					type="button"
					onClick={() => onToggleExport(thread.id)}
					aria-pressed={exportSelected}
					data-testid="github-thread-export-toggle"
					className={`dev3-inline-comment__button inline-flex h-7 items-center gap-1.5 rounded-md border px-2 text-[0.6875rem] font-semibold transition-colors ${
						exportSelected
							? "border-accent/40 bg-accent/15 text-accent"
							: "border-edge bg-base text-fg-2 hover:bg-elevated-hover"
					}`}
				>
					<span
						aria-hidden="true"
						className={`inline-flex h-3.5 w-3.5 items-center justify-center rounded-[3px] border text-[0.6rem] leading-none ${
							exportSelected ? "border-accent bg-accent text-white" : "border-edge bg-base text-transparent"
						}`}
					>
						{"✓"}
					</span>
					<span>{exportSelected ? t("infoPanel.prIncludedInExport") : t("infoPanel.prIncludeInExport")}</span>
				</button>
				<button
					type="button"
					onClick={() => onSendToAgent(thread)}
					disabled={sendState === "sending"}
					data-testid="github-thread-send"
					className={`dev3-inline-comment__button dev3-inline-comment__button--secondary inline-flex h-7 items-center gap-1.5 rounded-md border px-2 text-[0.6875rem] font-semibold transition-colors ${
						sendState === "sent"
							? "border-success/40 bg-success/10 text-success"
							: "border-edge bg-base text-fg-2 hover:bg-elevated-hover disabled:cursor-not-allowed disabled:text-fg-muted"
					}`}
				>
					<span aria-hidden="true" className="text-[0.8rem] leading-none" style={{ fontFamily: NERD_FONT }}>
						{TERMINAL_GLYPH}
					</span>
					<span>
						{sendState === "sending"
							? t("infoPanel.prSendToAgentSending")
							: sendState === "sent"
								? t("infoPanel.prSendToAgentSent")
								: t("infoPanel.prSendToAgent")}
					</span>
				</button>
			</div>
		</div>
	);
}

/** Collapsed-by-default group of threads that no longer anchor onto the rendered diff. */
export function OutdatedThreadsGroup({
	threads,
	open,
	onToggle,
	exportSelection,
	onToggleExport,
	onSendToAgent,
	sendStates,
	registerRef,
}: {
	threads: PRReviewThread[];
	open: boolean;
	onToggle: () => void;
	exportSelection: Record<string, boolean>;
	onToggleExport: (threadId: string) => void;
	onSendToAgent: (thread: PRReviewThread) => void;
	sendStates: Record<string, ThreadSendState>;
	registerRef?: (id: string, element: HTMLDivElement | null) => void;
}) {
	const t = useT();
	if (threads.length === 0) {
		return null;
	}
	return (
		<div className="border-t border-edge" data-testid="github-outdated-group">
			<button
				type="button"
				onClick={onToggle}
				aria-expanded={open}
				className="flex w-full items-center gap-2 px-4 py-2 text-left text-[0.6875rem] font-semibold uppercase tracking-[0.08em] text-fg-3 transition-colors hover:bg-elevated-hover"
			>
				<span aria-hidden="true">{open ? "▾" : "▸"}</span>
				<span>{t("infoPanel.prOutdatedGroup")}</span>
				<span className="rounded bg-raised px-1.5 py-px font-mono text-[0.625rem] text-fg-3">{threads.length}</span>
			</button>
			{open && threads.map((thread) => (
				<GithubThreadView
					key={thread.id}
					thread={thread}
					exportSelected={!!exportSelection[thread.id]}
					onToggleExport={onToggleExport}
					onSendToAgent={onSendToAgent}
					sendState={sendStates[thread.id]}
					registerRef={registerRef}
				/>
			))}
		</div>
	);
}
