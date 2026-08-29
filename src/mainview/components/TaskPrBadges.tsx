import type { TaskPRBadgeInfo } from "../../shared/types";
import { summarizeMergeability, type PRMergeabilityReason } from "../../shared/pr-status";
import { useT, type TranslationKey } from "../i18n";
import TaskPrStatusPopover from "./TaskPrStatusPopover";

const MERGE_BADGE_REASON: Record<PRMergeabilityReason, TranslationKey> = {
	conflict: "task.mergeBadge.conflict",
	blocked: "task.mergeBadge.blocked",
	behind: "task.mergeBadge.behind",
	draft: "task.mergeBadge.draft",
	unstable: "task.mergeBadge.unstable",
	hooks: "task.mergeBadge.blocked",
};

const REVIEW_BADGE: Record<NonNullable<TaskPRBadgeInfo["reviewState"]>, { glyph: string | null; square?: boolean; cls: string; key: TranslationKey }> = {
	approved: { glyph: null, square: true, cls: "text-success bg-success/10 hover:bg-success/20", key: "task.review.approved" },
	changes_requested: { glyph: "\uf071", cls: "text-danger bg-danger/10 hover:bg-danger/20", key: "task.review.changesRequested" },
	commented: { glyph: "\uf075", cls: "text-warning-strong bg-warning/10 hover:bg-warning/20", key: "task.review.commented" },
};

interface TaskPrBadgesProps {
	prInfo: TaskPRBadgeInfo;
	projectId: string;
	taskId: string;
	/** Makes the popover's unresolved-comments row a deep link into the diff. */
	onShowUnresolved?: () => void;
}

/**
 * The task's pull-request signal cluster: number, mergeability, review verdict,
 * unresolved comments. Every badge opens the PR; hovering any one of them opens
 * the shared checks/conflict popover.
 *
 * Rendered as a fragment of siblings so the host's flex row keeps laying them
 * out one by one. Each badge past the number is independently null-guarded, so a
 * PR whose state nothing has polled yet shows the number alone — never a
 * spinner and never a guessed verdict.
 *
 * Mergeability replaces a standalone CI badge on purpose: GitHub's merge-state
 * already folds failing/blocking checks into one verdict, and the popover keeps
 * the per-check breakdown for detail.
 */
export default function TaskPrBadges({ prInfo, projectId, taskId, onShowUnresolved }: TaskPrBadgesProps) {
	const t = useT();
	const mergeability = summarizeMergeability(prInfo.mergeState);
	const reviewMeta = prInfo.reviewState ? REVIEW_BADGE[prInfo.reviewState] : null;
	const unresolvedCount = prInfo.unresolvedCount ?? 0;
	const ok = mergeability.state === "mergeable";
	const mergeLabel = ok
		? t("task.mergeBadge.mergeable")
		: mergeability.reason
			? t(MERGE_BADGE_REASON[mergeability.reason])
			: t("task.mergeBadge.notMergeable");

	return (
		<>
			<TaskPrStatusPopover prInfo={prInfo} projectId={projectId} taskId={taskId} onShowUnresolved={onShowUnresolved}>
				<button
					type="button"
					onClick={(e) => {
						e.stopPropagation();
						window.open(prInfo.url, "_blank");
					}}
					className="inline-flex h-5 max-w-full flex-shrink-0 items-center gap-1 rounded bg-success/10 px-1.5 py-0.5 font-mono text-dense font-semibold leading-none text-success transition-colors hover:bg-success/20"
					aria-label={t("task.openPR", { number: String(prInfo.number) })}
				>
					<span className="text-micro leading-none" style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>{"\u{F0401}"}</span>
					<span className="leading-none">{t("task.prNumber", { number: String(prInfo.number) })}</span>
				</button>
			</TaskPrStatusPopover>

			{mergeability.state !== "unknown" && (
				<TaskPrStatusPopover prInfo={prInfo} projectId={projectId} taskId={taskId} onShowUnresolved={onShowUnresolved}>
					<button
						type="button"
						onClick={(e) => {
							e.stopPropagation();
							window.open(prInfo.url, "_blank");
						}}
						className={`inline-flex h-5 max-w-full flex-shrink-0 items-center gap-1 rounded px-1.5 py-0.5 font-mono text-dense font-semibold leading-none transition-colors ${ok ? "text-success bg-success/10 hover:bg-success/20" : "text-danger bg-danger/10 hover:bg-danger/20"}`}
						aria-label={t(ok ? "task.mergeBadge.mergeableAria" : "task.mergeBadge.notMergeableAria")}
					>
						<span className="text-micro leading-none" style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>{ok ? "\u{F0623}" : "\uf05e"}</span>
						<span className="truncate leading-none">{mergeLabel}</span>
					</button>
				</TaskPrStatusPopover>
			)}

			{reviewMeta && (
				<TaskPrStatusPopover prInfo={prInfo} projectId={projectId} taskId={taskId} onShowUnresolved={onShowUnresolved}>
					<button
						type="button"
						onClick={(e) => {
							e.stopPropagation();
							window.open(prInfo.url, "_blank");
						}}
						className={`inline-flex flex-shrink-0 items-center rounded font-mono text-dense font-semibold leading-none transition-colors ${reviewMeta.square ? "h-5 w-5 justify-center p-0" : "h-5 gap-1 px-1.5 py-0.5"} ${reviewMeta.cls}`}
						aria-label={t(reviewMeta.key)}
					>
						{reviewMeta.glyph === null ? (
							<svg
								className="h-3.5 w-3.5"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								strokeWidth="2"
								strokeLinecap="round"
								strokeLinejoin="round"
								aria-hidden="true"
							>
								<circle cx="8.5" cy="7.5" r="3" />
								<path d="M3.5 19c.4-3.2 2.1-5 5-5s4.6 1.8 5 5" />
								<path d="m15 17 2 2 4-5" />
							</svg>
						) : (
							<span className="text-micro leading-none" style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>{reviewMeta.glyph}</span>
						)}
					</button>
				</TaskPrStatusPopover>
			)}

			{unresolvedCount > 0 && (
				<TaskPrStatusPopover prInfo={prInfo} projectId={projectId} taskId={taskId} onShowUnresolved={onShowUnresolved}>
					<button
						type="button"
						onClick={(e) => {
							e.stopPropagation();
							window.open(prInfo.url, "_blank");
						}}
						className="inline-flex h-5 flex-shrink-0 items-center gap-1 rounded bg-warning/10 px-1.5 py-0.5 font-mono text-dense font-semibold leading-none text-warning-strong transition-colors hover:bg-warning/20"
						aria-label={t.plural("task.prUnresolvedComments", unresolvedCount)}
					>
						<span className="text-micro leading-none" style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>{"\uF086"}</span>
						<span className="leading-none">{unresolvedCount}</span>
					</button>
				</TaskPrStatusPopover>
			)}
		</>
	);
}
