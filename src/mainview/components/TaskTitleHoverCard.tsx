import { createPortal } from "react-dom";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { Label, Project, Task } from "../../shared/types";
import { getTaskTitle, taskSeqLabel } from "../../shared/types";
import { useT } from "../i18n";
import { compactAge } from "../utils/statusAge";
import { computeAnchoredPosition } from "../utils/popoverPosition";
import { useNarrowViewport } from "../hooks/useNarrowViewport";
import { useProjectPrivacy } from "../sensitive-projects";
import { CAROUSEL_MAX_WIDTH } from "./MobileBoardCarousel";
import LabelChip from "./LabelChip";

interface TaskTitleHoverCardProps {
	task: Task;
	project: Project | null;
	children: ReactNode;
}

/**
 * Hover card on the breadcrumb task title: the facts that used to eat width in
 * the summary bar (labels, branch, seq, age) live here instead, one hover away.
 * Hover-only by design — on touch it stays out of the way, the task view itself
 * carries the same facts.
 */
export default function TaskTitleHoverCard({ task, project, children }: TaskTitleHoverCardProps) {
	const t = useT();
	const narrow = useNarrowViewport(CAROUSEL_MAX_WIDTH);
	const privacy = useProjectPrivacy();
	const [open, setOpen] = useState(false);
	const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
	const triggerRef = useRef<HTMLSpanElement | null>(null);
	const cardRef = useRef<HTMLDivElement | null>(null);
	const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	const cancelHide = useCallback(() => {
		if (hideTimerRef.current) {
			clearTimeout(hideTimerRef.current);
			hideTimerRef.current = null;
		}
	}, []);

	const hide = useCallback(() => {
		cancelHide();
		setOpen(false);
		setPosition(null);
	}, [cancelHide]);

	const scheduleHide = useCallback(() => {
		cancelHide();
		hideTimerRef.current = setTimeout(() => {
			hideTimerRef.current = null;
			hide();
		}, 160);
	}, [cancelHide, hide]);

	useEffect(() => () => cancelHide(), [cancelHide]);
	useEffect(() => { hide(); }, [hide, task.id]);

	useEffect(() => {
		if (!open) return;
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") hide();
		};
		document.addEventListener("keydown", onKeyDown, true);
		return () => document.removeEventListener("keydown", onKeyDown, true);
	}, [hide, open]);

	useLayoutEffect(() => {
		if (!open || !triggerRef.current || !cardRef.current) return;
		const rect = triggerRef.current.getBoundingClientRect();
		const next = computeAnchoredPosition(
			{ top: rect.top, left: rect.left, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height },
			{ width: cardRef.current.offsetWidth, height: cardRef.current.offsetHeight },
			{ placement: "bottom", align: "start" },
		);
		setPosition({ top: next.top, left: next.left });
	}, [open]);

	const labels = (task.labelIds ?? [])
		.map((id) => (project?.labels ?? []).find((item) => item.id === id))
		.filter(Boolean) as Label[];
	const branch = task.branchName ?? task.existingBranch ?? null;
	const age = compactAge(task.createdAt);

	const row = (label: string, value: ReactNode) => (
		<div className="flex items-baseline gap-2">
			<span className="w-[4.5rem] flex-shrink-0 text-dense uppercase tracking-wider text-fg-muted">{label}</span>
			<span className="min-w-0 flex-1 text-micro text-fg-2">{value}</span>
		</div>
	);

	return (
		<>
			<span
				ref={triggerRef}
				className="flex items-baseline gap-1.5 min-w-0 overflow-hidden"
				onMouseEnter={() => { if (!narrow) { cancelHide(); setOpen(true); } }}
				onMouseLeave={scheduleHide}
			>
				{children}
			</span>
			{open && createPortal(
				<div
					ref={cardRef}
					data-testid="task-title-hover-card"
					className="fixed z-50 w-[22rem] max-w-[90vw] rounded-xl border border-edge-active bg-overlay p-3 shadow-2xl shadow-black/40"
					style={{ top: position?.top ?? -9999, left: position?.left ?? -9999, visibility: position ? "visible" : "hidden" }}
					onMouseEnter={cancelHide}
					onMouseLeave={scheduleHide}
				>
					<div className="mb-2 text-micro font-semibold leading-snug text-fg">
						{getTaskTitle(task)}
					</div>
					<div className="flex flex-col gap-1.5">
						{row(t("taskHover.seq"), <span className="font-mono">#{taskSeqLabel(task)}</span>)}
						{row(
							t("taskHover.branch"),
							branch
								? <span className={`font-mono break-all ${privacy.maskClass(project ?? task.projectId)}`}>{branch}</span>
								: <span className="text-fg-muted">{t("taskHover.none")}</span>,
						)}
						{row(
							t("taskHover.labels"),
							labels.length > 0
								? (
									<span className="flex flex-wrap items-center gap-1">
										{labels.map((label) => <LabelChip key={label.id} label={label} size="xs" />)}
									</span>
								)
								: <span className="text-fg-muted">{t("taskHover.none")}</span>,
						)}
						{age && row(t("taskHover.age"), age)}
					</div>
				</div>,
				document.body,
			)}
		</>
	);
}
