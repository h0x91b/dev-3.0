import { createPortal } from "react-dom";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactElement } from "react";
import type { PRCheckInfo, TaskPRBadgeInfo } from "../../shared/types";
import { summarizeMergeability, type PRMergeabilityReason } from "../../shared/pr-status";
import { api } from "../rpc";
import { useT } from "../i18n";
import { toast } from "../toast";
import { computeAnchoredPosition, type RectLike } from "../utils/popoverPosition";
import { useNarrowViewport } from "../hooks/useNarrowViewport";
import { CAROUSEL_MAX_WIDTH } from "./MobileBoardCarousel";
import BottomSheet from "./BottomSheet";

interface TaskPrStatusPopoverProps {
	prInfo: TaskPRBadgeInfo;
	projectId: string;
	taskId: string;
	/** When provided, the "N unresolved comments" row becomes a deep link that
	 * opens the diff review at the first unresolved GitHub thread. */
	onShowUnresolved?: () => void;
	children: ReactElement;
}

type CheckState = "failure" | "pending" | "success" | "unknown";

function checkState(check: PRCheckInfo): CheckState {
	const verdict = (check.conclusion ?? check.status ?? "").toUpperCase();
	if (["FAILURE", "FAILED", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"].includes(verdict)) {
		return "failure";
	}
	if (["PENDING", "EXPECTED", "QUEUED", "IN_PROGRESS", "REQUESTED", "WAITING"].includes(verdict)) {
		return "pending";
	}
	if (["SUCCESS", "NEUTRAL", "SKIPPED"].includes(verdict)) return "success";
	return "unknown";
}

const CHECK_ORDER: Record<CheckState, number> = {
	failure: 0,
	pending: 1,
	success: 2,
	unknown: 3,
};

const CHECK_LIST_MAX_HEIGHT_CLASS = "max-h-[17.5rem]";
const AUTO_REFRESH_DELAY_MS = 2000;

function sortedChecks(checks: PRCheckInfo[]): PRCheckInfo[] {
	return checks
		.map((check, index) => ({ check, index }))
		.sort((a, b) => CHECK_ORDER[checkState(a.check)] - CHECK_ORDER[checkState(b.check)] || a.index - b.index)
		.map(({ check }) => check);
}

function checkStatusLabel(state: CheckState, t: ReturnType<typeof useT>): string {
	switch (state) {
		case "failure": return t("task.prCheckFailed");
		case "pending": return t("task.prCheckPending");
		case "success": return t("task.prCheckPassed");
		default: return t("task.prCheckUnknown");
	}
}

function checkGlyph(state: CheckState): string {
	switch (state) {
		case "failure": return "";
		case "pending": return "";
		case "success": return "";
		default: return "";
	}
}

function checkClass(state: CheckState): string {
	switch (state) {
		case "failure": return "text-danger";
		case "pending": return "text-warning";
		case "success": return "text-success";
		default: return "text-fg-3";
	}
}

function mergeReasonLabel(reason: PRMergeabilityReason, t: ReturnType<typeof useT>): string {
	switch (reason) {
		case "conflict": return t("task.prMergeReasonConflict");
		case "blocked": return t("task.prMergeReasonBlocked");
		case "behind": return t("task.prMergeReasonBehind");
		case "draft": return t("task.prMergeReasonDraft");
		case "unstable": return t("task.prMergeReasonUnstable");
		case "hooks": return t("task.prMergeReasonHooks");
	}
}

interface MergeReasonDetail {
	key: string;
	label: string;
}

function mergeReasonDetails(
	prInfo: TaskPRBadgeInfo,
	mergeability: ReturnType<typeof summarizeMergeability>,
	t: ReturnType<typeof useT>,
): MergeReasonDetail[] {
	const reasons: MergeReasonDetail[] = [];
	const add = (key: string, label: string) => reasons.push({ key, label });

	if (mergeability.reason && mergeability.reason !== "blocked") {
		add(mergeability.reason, mergeReasonLabel(mergeability.reason, t));
	}
	if (prInfo.unresolvedCount != null && prInfo.unresolvedCount > 0) {
		add("unresolved-comments", t("task.prMergeReasonUnresolvedComments"));
	}
	if (prInfo.reviewDecision === "review_required") {
		add("review-required", t("task.prMergeReasonReviewRequired"));
	} else if (prInfo.reviewDecision === "changes_requested") {
		add("changes-requested", t("task.prMergeReasonChangesRequested"));
	}

	const failedChecks = (prInfo.checks ?? [])
		.filter((check) => checkState(check) === "failure")
		.map((check) => check.name || t("task.prUnnamedCheck"));
	if (failedChecks.length > 0) {
		add("failed-checks", t("task.prMergeReasonFailedChecks", { checks: [...new Set(failedChecks)].join(", ") }));
	}

	const pendingChecks = (prInfo.checks ?? [])
		.filter((check) => checkState(check) === "pending")
		.map((check) => check.name || t("task.prUnnamedCheck"));
	if (pendingChecks.length > 0) {
		add("pending-checks", t("task.prMergeReasonPendingChecks", { checks: [...new Set(pendingChecks)].join(", ") }));
	}
	if (reasons.length === 0 && mergeability.reason) {
		add(mergeability.reason, mergeReasonLabel(mergeability.reason, t));
	}

	return reasons;
}

function anchorRect(element: HTMLElement): RectLike {
	const rect = element.getBoundingClientRect();
	return {
		top: rect.top,
		left: rect.left,
		right: rect.right,
		bottom: rect.bottom,
		width: rect.width,
		height: rect.height,
	};
}

export default function TaskPrStatusPopover({ prInfo, projectId, taskId, onShowUnresolved, children }: TaskPrStatusPopoverProps) {
	const t = useT();
	const narrow = useNarrowViewport(CAROUSEL_MAX_WIDTH);
	const [open, setOpen] = useState(false);
	const [sheetOpen, setSheetOpen] = useState(false);
	const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
	const [refreshing, setRefreshing] = useState(false);
	const triggerRef = useRef<HTMLSpanElement>(null);
	const popoverRef = useRef<HTMLDivElement>(null);
	const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const autoRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const autoRefreshAttemptedRef = useRef(false);
	const pointerInsideRef = useRef(false);
	const openRef = useRef(false);
	const refreshingRef = useRef(false);

	const cancelHide = useCallback(() => {
		if (hideTimerRef.current !== null) {
			clearTimeout(hideTimerRef.current);
			hideTimerRef.current = null;
		}
	}, []);

	const cancelAutoRefresh = useCallback(() => {
		if (autoRefreshTimerRef.current !== null) {
			clearTimeout(autoRefreshTimerRef.current);
			autoRefreshTimerRef.current = null;
		}
	}, []);

	const hide = useCallback(() => {
		cancelHide();
		cancelAutoRefresh();
		pointerInsideRef.current = false;
		openRef.current = false;
		setOpen(false);
		setPosition(null);
	}, [cancelAutoRefresh, cancelHide]);

	const show = useCallback(() => {
		cancelHide();
		openRef.current = true;
		setOpen(true);
	}, [cancelHide]);

	const scheduleHide = useCallback(() => {
		cancelHide();
		hideTimerRef.current = setTimeout(() => {
			hideTimerRef.current = null;
			hide();
		}, 160);
	}, [cancelHide, hide]);

	const refresh = useCallback(async () => {
		if (refreshingRef.current) return;
		autoRefreshAttemptedRef.current = true;
		cancelAutoRefresh();
		refreshingRef.current = true;
		setRefreshing(true);
		try {
			await api.request.refreshTaskPrStatus({ taskId, projectId });
		} catch (error) {
			toast.error(t("task.prRefreshFailed", { error: String(error) }));
		} finally {
			refreshingRef.current = false;
			setRefreshing(false);
		}
	}, [cancelAutoRefresh, projectId, t, taskId]);

	const scheduleAutoRefresh = useCallback(() => {
		if (autoRefreshAttemptedRef.current || autoRefreshTimerRef.current !== null) return;
		autoRefreshTimerRef.current = setTimeout(() => {
			autoRefreshTimerRef.current = null;
			if (!pointerInsideRef.current || !openRef.current || autoRefreshAttemptedRef.current) return;
			autoRefreshAttemptedRef.current = true;
			void refresh();
		}, AUTO_REFRESH_DELAY_MS);
	}, [refresh]);

	const handlePointerEnter = useCallback(() => {
		pointerInsideRef.current = true;
		show();
		scheduleAutoRefresh();
	}, [scheduleAutoRefresh, show]);

	const handlePointerLeave = useCallback(() => {
		pointerInsideRef.current = false;
		scheduleHide();
	}, [scheduleHide]);

	useEffect(() => () => {
		cancelHide();
		cancelAutoRefresh();
	}, [cancelAutoRefresh, cancelHide]);

	useEffect(() => {
		if (!open) return;
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") hide();
		};
		const onScroll = (event: Event) => {
			const target = event.target;
			if (target instanceof Node && popoverRef.current?.contains(target)) return;
			hide();
		};
		document.addEventListener("keydown", onKeyDown, true);
		window.addEventListener("scroll", onScroll, true);
		return () => {
			document.removeEventListener("keydown", onKeyDown, true);
			window.removeEventListener("scroll", onScroll, true);
		};
	}, [hide, open]);

	useLayoutEffect(() => {
		if (!open || !triggerRef.current || !popoverRef.current) return;
		const next = computeAnchoredPosition(
			anchorRect(triggerRef.current),
			{ width: popoverRef.current.offsetWidth, height: popoverRef.current.offsetHeight },
			{ placement: "bottom", align: "start" },
		);
		setPosition({ top: next.top, left: next.left });
	}, [open, prInfo]);

	// Narrow (mobile): auto-refresh once shortly after the sheet opens, mirroring
	// the desktop hover auto-refresh.
	useEffect(() => {
		if (!sheetOpen || autoRefreshAttemptedRef.current) return;
		const timer = setTimeout(() => {
			autoRefreshAttemptedRef.current = true;
			void refresh();
		}, AUTO_REFRESH_DELAY_MS);
		return () => clearTimeout(timer);
	}, [refresh, sheetOpen]);

	const checks = sortedChecks(prInfo.checks ?? []);
	const mergeability = summarizeMergeability(prInfo.mergeState);
	const autoMergeLabel = prInfo.autoMergeEnabled === true
		? t("task.prEnabled")
		: prInfo.autoMergeEnabled === false
			? t("task.prNotSet")
			: t("task.prUnknown");
	const autoMergeClass = prInfo.autoMergeEnabled === true ? "text-success" : "text-fg-3";
	const mergeabilityLabel = mergeability.state === "mergeable"
		? t("task.prMergeableYes")
		: mergeability.state === "not_mergeable"
			? t("task.prMergeableNo")
			: t("task.prMergeableUnknown");
	const mergeabilityClass = mergeability.state === "mergeable"
		? "text-success"
		: mergeability.state === "not_mergeable"
			? "text-danger"
			: "text-fg-3";
	const mergeReasons = mergeability.state === "not_mergeable" ? mergeReasonDetails(prInfo, mergeability, t) : [];
	const prState = prInfo.mergeState?.state?.toUpperCase();
	const prStateMeta = prState === "OPEN"
		? { label: t("task.prStatusOpen"), className: "text-fg-3" }
		: prState === "MERGED"
			? { label: t("task.prStatusMerged"), className: "text-success" }
			: prState === "CLOSED"
				? { label: t("task.prStatusClosed"), className: "text-danger" }
				: null;

	// Shared body between the desktop hover popover and the mobile bottom sheet.
	// `sheet` relaxes the density: no header row (the sheet has its own title),
	// no capped check list (the sheet itself scrolls), taller touch targets.
	const statusBody = (sheet: boolean) => (
		<>
			{!sheet && (
				<div className="flex items-start justify-between gap-3">
					<div className="min-w-0">
						<div className="font-semibold text-fg">{t("task.prStatusPopover", { number: String(prInfo.number) })}</div>
						{prInfo.prTitle && <div className="mt-0.5 truncate text-fg-3" title={prInfo.prTitle}>{prInfo.prTitle}</div>}
					</div>
					{prInfo.isDraft && <span className="flex-shrink-0 rounded bg-warning/10 px-1.5 py-0.5 font-medium text-warning">{t("task.prDraft")}</span>}
				</div>
			)}
			{sheet && (prInfo.prTitle || prInfo.isDraft) && (
				<div className="flex items-start justify-between gap-3">
					{prInfo.prTitle && <div className="min-w-0 break-words text-fg-3">{prInfo.prTitle}</div>}
					{prInfo.isDraft && <span className="flex-shrink-0 rounded bg-warning/10 px-1.5 py-0.5 font-medium text-warning">{t("task.prDraft")}</span>}
				</div>
			)}

			{prInfo.unresolvedCount != null && prInfo.unresolvedCount > 0 && (
				onShowUnresolved ? (
					<button
						type="button"
						data-testid="pr-popover-unresolved"
						onClick={() => {
							hide();
							setSheetOpen(false);
							onShowUnresolved();
						}}
						title={t("task.prShowUnresolvedInDiff")}
						aria-label={t("task.prShowUnresolvedInDiff")}
						className="mt-2 flex items-center gap-1.5 rounded text-warning transition-colors hover:underline focus:outline-none focus:ring-1 focus:ring-accent"
					>
						<span className="leading-none" style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>{""}</span>
						<span>{t.plural("task.prUnresolvedComments", prInfo.unresolvedCount)}</span>
					</button>
				) : (
					<div className="mt-2 flex items-center gap-1.5 text-warning">
						<span className="leading-none" style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>{""}</span>
						<span>{t.plural("task.prUnresolvedComments", prInfo.unresolvedCount)}</span>
					</div>
				)
			)}

			{prInfo.mergeState?.mergeable === "CONFLICTING" && (
				<div className="mt-2 flex items-center gap-1.5 text-danger">
					<span className="leading-none" style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>{""}</span>
					<span>{t("task.prConflict")}</span>
				</div>
			)}

			<div className="mt-3">
				<div className="mb-1.5 font-medium text-fg-2">{t("task.prMergeStatus")}</div>
				<dl className="space-y-1">
					{prStateMeta && (
						<div className="flex items-center justify-between gap-3">
							<dt className="text-fg-3">{t("task.prStatusLabel")}</dt>
							<dd className={`font-medium ${prStateMeta.className}`}>{prStateMeta.label}</dd>
						</div>
					)}
					<div className="flex items-center justify-between gap-3">
						<dt className="text-fg-3">{t("task.prAutoMerge")}</dt>
						<dd className={`font-medium ${autoMergeClass}`}>{autoMergeLabel}</dd>
					</div>
					<div className="flex items-center justify-between gap-3">
						<dt className="text-fg-3">{t("task.prMergeable")}</dt>
						<dd className={`font-medium ${mergeabilityClass}`}>{mergeabilityLabel}</dd>
					</div>
					{mergeReasons.length > 0 && (
						<div className="flex items-start justify-between gap-3">
							<dt className="flex-shrink-0 text-fg-3">{t("task.prMergeReason")}</dt>
							<dd className="min-w-0 text-right text-danger">
								<div className="space-y-0.5 break-words">
									{mergeReasons.map((reason) => <div key={reason.key}>{reason.label}</div>)}
								</div>
							</dd>
						</div>
					)}
				</dl>
			</div>

			<div className="mt-3">
				<div className="mb-1.5 font-medium text-fg-2">{t("task.prChecks")}</div>
				{checks.length === 0 ? (
					<div className="text-fg-muted">{t("task.prNoChecks")}</div>
				) : (
					<ul
						data-testid="pr-check-list"
						className={sheet ? "space-y-1" : `${CHECK_LIST_MAX_HEIGHT_CLASS} space-y-1 overflow-y-auto pr-1`}
					>
						{checks.map((check, index) => {
							const state = checkState(check);
							const name = check.name || t("task.prUnnamedCheck");
							const row = (
								<span className="flex min-w-0 items-center gap-2">
									<span className={"flex-shrink-0 leading-none " + checkClass(state)} style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>{checkGlyph(state)}</span>
									<span className="min-w-0 flex-1 truncate text-fg-2">{name}</span>
									<span className={"flex-shrink-0 " + (sheet ? "text-xs " : "text-[0.625rem] ") + checkClass(state)}>{checkStatusLabel(state, t)}</span>
								</span>
							);
							const rowPadding = sheet ? "px-1 py-2" : "px-1 py-1";
							return (
								<li key={name + "-" + index}>
									{check.detailsUrl ? (
										<a
											href={check.detailsUrl}
											target="_blank"
											rel="noreferrer"
											className={`block rounded ${rowPadding} hover:bg-elevated-hover focus:outline-none focus:ring-1 focus:ring-accent`}
											aria-label={t("task.prCheckDetails", { name })}
										>
											{row}
										</a>
									) : <div className={rowPadding}>{row}</div>}
								</li>
							);
						})}
					</ul>
				)}
			</div>

			<button
				type="button"
				onClick={() => void refresh()}
				disabled={refreshing}
				aria-label={t(refreshing ? "task.prRefreshing" : "task.prRefresh")}
				className={`mt-3 inline-flex items-center gap-1.5 rounded text-fg-2 transition-colors hover:bg-elevated-hover hover:text-fg disabled:cursor-not-allowed disabled:opacity-50 ${sheet ? "px-2 py-2" : "px-2 py-1"}`}
			>
				<span className={refreshing ? "animate-spin" : ""} style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>{""}</span>
				<span>{t(refreshing ? "task.prRefreshing" : "task.prRefresh")}</span>
			</button>
		</>
	);

	if (narrow) {
		// Touch: the hover popover is unreachable and the badge's own click
		// (window.open of the PR) steals the tap, so intercept taps on the
		// trigger in the capture phase and show a bottom sheet instead. Clicks
		// inside the portaled sheet bubble back through the React tree, so stop
		// them here before they reach the task card's onClick.
		return (
			<span
				ref={triggerRef}
				className="inline-flex"
				onClickCapture={(event) => {
					if (!(event.target instanceof Node) || !triggerRef.current?.contains(event.target)) return;
					event.preventDefault();
					event.stopPropagation();
					setSheetOpen(true);
				}}
				onClick={(event) => event.stopPropagation()}
			>
				{children}
				<BottomSheet
					open={sheetOpen}
					onClose={() => setSheetOpen(false)}
					title={t("task.prStatusPopover", { number: String(prInfo.number) })}
					testId="pr-status-sheet"
				>
					<div className="text-sm">
						{statusBody(true)}
						<a
							href={prInfo.url}
							target="_blank"
							rel="noreferrer"
							className="mt-3 flex h-11 items-center justify-center gap-2 rounded-lg bg-elevated font-medium text-accent transition-colors hover:bg-elevated-hover"
						>
							<span aria-hidden className="leading-none" style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>{"\u{F0401}"}</span>
							<span>{t("task.openPR", { number: String(prInfo.number) })}</span>
						</a>
					</div>
				</BottomSheet>
			</span>
		);
	}

	const popover = open && createPortal(
		<div
			ref={popoverRef}
			role="dialog"
			aria-label={t("task.prStatusPopover", { number: String(prInfo.number) })}
			data-testid="pr-status-popover"
			className="fixed z-[1200] w-[min(22rem,calc(100vw-1rem))] rounded-lg border border-edge-active bg-overlay p-3 text-xs shadow-2xl"
			style={{ top: position?.top ?? 0, left: position?.left ?? 0, visibility: position ? "visible" : "hidden" }}
			onMouseEnter={handlePointerEnter}
			onMouseLeave={handlePointerLeave}
			onBlur={(event) => {
				const nextTarget = event.relatedTarget as Node | null;
				if (nextTarget && (popoverRef.current?.contains(nextTarget) || triggerRef.current?.contains(nextTarget))) return;
				scheduleHide();
			}}
			onClick={(event) => event.stopPropagation()}
		>
			{statusBody(false)}
		</div>,
		document.body,
	);

	return (
		<span
			ref={triggerRef}
			className="inline-flex"
			onMouseEnter={handlePointerEnter}
			onMouseLeave={handlePointerLeave}
			onFocus={show}
			onBlur={(event) => {
				const nextTarget = event.relatedTarget as Node | null;
				if (nextTarget && popoverRef.current?.contains(nextTarget)) return;
				scheduleHide();
			}}
		>
			{children}
			{popover}
		</span>
	);
}
