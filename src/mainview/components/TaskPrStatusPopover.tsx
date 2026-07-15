import { createPortal } from "react-dom";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactElement } from "react";
import type { PRCheckInfo, TaskPRBadgeInfo } from "../../shared/types";
import { api } from "../rpc";
import { useT } from "../i18n";
import { toast } from "../toast";
import { computeAnchoredPosition, type RectLike } from "../utils/popoverPosition";

interface TaskPrStatusPopoverProps {
	prInfo: TaskPRBadgeInfo;
	projectId: string;
	taskId: string;
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

export default function TaskPrStatusPopover({ prInfo, projectId, taskId, children }: TaskPrStatusPopoverProps) {
	const t = useT();
	const [open, setOpen] = useState(false);
	const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
	const [refreshing, setRefreshing] = useState(false);
	const triggerRef = useRef<HTMLSpanElement>(null);
	const popoverRef = useRef<HTMLDivElement>(null);
	const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	const cancelHide = useCallback(() => {
		if (hideTimerRef.current !== null) {
			clearTimeout(hideTimerRef.current);
			hideTimerRef.current = null;
		}
	}, []);

	const hide = useCallback(() => {
		cancelHide();
		setOpen(false);
		setPosition(null);
	}, [cancelHide]);

	const show = useCallback(() => {
		cancelHide();
		if (triggerRef.current) setPosition(anchorRect(triggerRef.current));
		setOpen(true);
	}, [cancelHide]);

	const scheduleHide = useCallback(() => {
		cancelHide();
		hideTimerRef.current = setTimeout(() => {
			hideTimerRef.current = null;
			hide();
		}, 160);
	}, [cancelHide, hide]);

	useEffect(() => () => {
		cancelHide();
	}, [cancelHide]);

	useEffect(() => {
		if (!open) return;
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") hide();
		};
		const onScroll = () => hide();
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

	async function refresh() {
		if (refreshing) return;
		setRefreshing(true);
		try {
			await api.request.refreshTaskPrStatus({ taskId, projectId });
		} catch (error) {
			toast.error(t("task.prRefreshFailed", { error: String(error) }));
		} finally {
			setRefreshing(false);
		}
	}

	const checks = sortedChecks(prInfo.checks ?? []);
	const popover = open && createPortal(
		<div
			ref={popoverRef}
			role="dialog"
			aria-label={t("task.prStatusPopover", { number: String(prInfo.number) })}
			data-testid="pr-status-popover"
			className="fixed z-[1200] w-[min(22rem,calc(100vw-1rem))] rounded-lg border border-edge-active bg-overlay p-3 text-xs shadow-2xl"
			style={{ top: position?.top ?? 0, left: position?.left ?? 0, visibility: position ? "visible" : "hidden" }}
			onMouseEnter={cancelHide}
			onMouseLeave={scheduleHide}
			onBlur={(event) => {
				const nextTarget = event.relatedTarget as Node | null;
				if (nextTarget && (popoverRef.current?.contains(nextTarget) || triggerRef.current?.contains(nextTarget))) return;
				scheduleHide();
			}}
			onClick={(event) => event.stopPropagation()}
		>
			<div className="flex items-start justify-between gap-3">
				<div className="min-w-0">
					<div className="font-semibold text-fg">{t("task.prStatusPopover", { number: String(prInfo.number) })}</div>
					{prInfo.prTitle && <div className="mt-0.5 truncate text-fg-3" title={prInfo.prTitle}>{prInfo.prTitle}</div>}
				</div>
				{prInfo.isDraft && <span className="flex-shrink-0 rounded bg-warning/10 px-1.5 py-0.5 font-medium text-warning">{t("task.prDraft")}</span>}
			</div>

			{prInfo.unresolvedCount != null && prInfo.unresolvedCount > 0 && (
				<div className="mt-2 flex items-center gap-1.5 text-warning">
					<span className="leading-none" style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>{"\uF086"}</span>
					<span>{t.plural("task.prUnresolvedComments", prInfo.unresolvedCount)}</span>
				</div>
			)}

			{prInfo.mergeState?.mergeable === "CONFLICTING" && (
				<div className="mt-2 flex items-center gap-1.5 text-danger">
					<span className="leading-none" style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>{"\uF071"}</span>
					<span>{t("task.prConflict")}</span>
				</div>
			)}

			<div className="mt-3">
				<div className="mb-1.5 font-medium text-fg-2">{t("task.prChecks")}</div>
				{checks.length === 0 ? (
					<div className="text-fg-muted">{t("task.prNoChecks")}</div>
				) : (
					<ul data-testid="pr-check-list" className={`${CHECK_LIST_MAX_HEIGHT_CLASS} space-y-1 overflow-y-auto pr-1`}>
						{checks.map((check, index) => {
							const state = checkState(check);
							const name = check.name || t("task.prUnnamedCheck");
							const row = (
								<span className="flex min-w-0 items-center gap-2">
									<span className={"flex-shrink-0 leading-none " + checkClass(state)} style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>{checkGlyph(state)}</span>
									<span className="min-w-0 flex-1 truncate text-fg-2">{name}</span>
									<span className={"flex-shrink-0 text-[0.625rem] " + checkClass(state)}>{checkStatusLabel(state, t)}</span>
								</span>
							);
							return (
								<li key={name + "-" + index}>
									{check.detailsUrl ? (
										<a
											href={check.detailsUrl}
											target="_blank"
											rel="noreferrer"
											className="block rounded px-1 py-1 hover:bg-elevated-hover focus:outline-none focus:ring-1 focus:ring-accent"
											aria-label={t("task.prCheckDetails", { name })}
										>
											{row}
										</a>
									) : <div className="px-1 py-1">{row}</div>}
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
				className="mt-3 inline-flex items-center gap-1.5 rounded px-2 py-1 text-fg-2 transition-colors hover:bg-elevated-hover hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
			>
				<span className={refreshing ? "animate-spin" : ""} style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>{"\uF021"}</span>
				<span>{t(refreshing ? "task.prRefreshing" : "task.prRefresh")}</span>
			</button>
		</div>,
		document.body,
	);

	return (
		<span
			ref={triggerRef}
			className="inline-flex"
			onMouseEnter={show}
			onMouseLeave={scheduleHide}
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
