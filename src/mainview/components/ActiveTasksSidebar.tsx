import { useState, useRef, useEffect, useCallback, type Dispatch } from "react";
import { createPortal } from "react-dom";
import type { Project, Task, TaskStatus } from "../../shared/types";
import { ACTIVE_STATUSES, getTaskTitle } from "../../shared/types";
import { useStatusColors } from "../hooks/useStatusColors";
import type { AppAction, Route } from "../state";
import { useT, statusKey } from "../i18n";
import { api } from "../rpc";
import { ansiToHtml } from "../utils/ansi-to-html";
import LabelChip from "./LabelChip";

interface ActiveTasksSidebarProps {
	project: Project;
	tasks: Task[];
	activeTaskId?: string;
	dispatch: Dispatch<AppAction>;
	navigate: (route: Route) => void;
	bellCounts: Map<string, number>;
	onSwitchToBoard: () => void;
}

/** Status display order: most actionable for the user first */
const STATUS_ORDER: TaskStatus[] = [
	"review-by-user",
	"user-questions",
	"in-progress",
	"review-by-ai",
];

function ActiveTasksSidebar({
	project,
	tasks,
	activeTaskId,
	navigate,
	bellCounts,
	onSwitchToBoard,
}: ActiveTasksSidebarProps) {
	const t = useT();
	const statusColors = useStatusColors();

	// Terminal preview state
	const [previewOpen, setPreviewOpen] = useState(false);
	const [previewHtml, setPreviewHtml] = useState<string | null>(null);
	const [previewLoading, setPreviewLoading] = useState(false);
	const [previewPos, setPreviewPos] = useState({ top: 0, left: 0 });
	const previewRef = useRef<HTMLDivElement>(null);
	const previewTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const previewCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const previewIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
	const previewTaskIdRef = useRef<string | null>(null);

	const cancelPreviewTimers = useCallback(() => {
		if (previewTimerRef.current) {
			clearTimeout(previewTimerRef.current);
			previewTimerRef.current = null;
		}
		if (previewCloseTimerRef.current) {
			clearTimeout(previewCloseTimerRef.current);
			previewCloseTimerRef.current = null;
		}
	}, []);

	const closePreview = useCallback(() => {
		cancelPreviewTimers();
		if (previewIntervalRef.current) {
			clearInterval(previewIntervalRef.current);
			previewIntervalRef.current = null;
		}
		setPreviewOpen(false);
		setPreviewHtml(null);
		setPreviewLoading(false);
		previewTaskIdRef.current = null;
	}, [cancelPreviewTimers]);

	const scheduleClose = useCallback(() => {
		previewCloseTimerRef.current = setTimeout(() => {
			closePreview();
		}, 200);
	}, [closePreview]);

	const cancelClose = useCallback(() => {
		if (previewCloseTimerRef.current) {
			clearTimeout(previewCloseTimerRef.current);
			previewCloseTimerRef.current = null;
		}
	}, []);

	function handleTaskMouseEnter(taskId: string, e: React.MouseEvent<HTMLButtonElement>) {
		cancelPreviewTimers();
		if (previewTaskIdRef.current && previewTaskIdRef.current !== taskId) {
			closePreview();
		}
		const target = e.currentTarget;
		previewTimerRef.current = setTimeout(async () => {
			const rect = target.getBoundingClientRect();
			const vw = window.innerWidth;
			const vh = window.innerHeight;
			const popW = 420;
			const popH = 320;
			const pad = 8;

			let left = rect.right + 8;
			let top = rect.top;

			if (left + popW > vw - pad) {
				left = rect.left - popW - 8;
			}
			if (left < pad) left = pad;
			if (top + popH > vh - pad) {
				top = vh - popH - pad;
			}
			if (top < pad) top = pad;

			setPreviewPos({ top, left });
			setPreviewOpen(true);
			setPreviewLoading(true);
			previewTaskIdRef.current = taskId;

			try {
				const content = await api.request.getTerminalPreview({ taskId });
				if (content) {
					setPreviewHtml(ansiToHtml(content));
				} else {
					setPreviewHtml(null);
				}
			} catch {
				setPreviewHtml(null);
			}
			setPreviewLoading(false);

			previewIntervalRef.current = setInterval(async () => {
				try {
					const content = await api.request.getTerminalPreview({ taskId });
					if (content) {
						setPreviewHtml(ansiToHtml(content));
					}
				} catch {
					// ignore
				}
			}, 1000);
		}, 400);
	}

	function handleTaskMouseLeave() {
		if (previewTimerRef.current) {
			clearTimeout(previewTimerRef.current);
			previewTimerRef.current = null;
		}
		if (previewOpen) {
			scheduleClose();
		}
	}

	// Clean up timers on unmount
	useEffect(() => {
		return () => {
			cancelPreviewTimers();
			if (previewIntervalRef.current) {
				clearInterval(previewIntervalRef.current);
				previewIntervalRef.current = null;
			}
		};
	}, [cancelPreviewTimers]);

	const activeTasks = tasks.filter((task) => ACTIVE_STATUSES.includes(task.status));

	// Group by status in display order
	const grouped = STATUS_ORDER
		.map((status) => ({
			status,
			tasks: activeTasks.filter((task) => task.status === status),
		}))
		.filter((g) => g.tasks.length > 0);

	function handleTaskClick(task: Task) {
		if (task.id === activeTaskId) {
			// Toggle: clicking active task closes split
			navigate({ screen: "project", projectId: project.id });
		} else {
			navigate({
				screen: "project",
				projectId: project.id,
				activeTaskId: task.id,
			});
		}
	}

	const projectLabels = project.labels ?? [];

	return (
		<div className="h-full flex flex-col bg-base">
			{/* Header */}
			<div className="flex items-center justify-between px-3 py-2.5 border-b border-edge flex-shrink-0">
				<span className="text-xs font-semibold text-fg-2 uppercase tracking-wider">
					{t("sidebar.activeTasks")}
				</span>
				<button
					onClick={onSwitchToBoard}
					className="text-[0.625rem] text-fg-muted hover:text-accent transition-colors px-1.5 py-0.5 rounded hover:bg-fg/5"
					title={t("sidebar.switchToBoard")}
				>
					{/* Nerd Font: fa-columns (U+F0DB) */}
					<span className="text-sm font-mono leading-none">{"\uF0DB"}</span>
				</button>
			</div>

			{/* Task list */}
			<div className="flex-1 overflow-y-auto overflow-x-hidden">
				{grouped.length === 0 ? (
					<div className="px-3 py-6 text-center text-xs text-fg-muted">
						{t("sidebar.noActiveTasks")}
					</div>
				) : (
					grouped.map(({ status, tasks: groupTasks }, groupIdx) => (
						<div key={status}>
							{/* Solid separator between status groups */}
							{groupIdx > 0 && (
								<div className="mx-3 border-t border-edge" />
							)}

							{/* Status group header */}
							<div className="px-3 py-1.5 flex items-center gap-2 sticky top-0 bg-base/95 backdrop-blur-sm z-10">
								<div
									className="w-2 h-2 rounded-full flex-shrink-0"
									style={{ background: statusColors[status] }}
								/>
								<span className="text-[0.625rem] font-semibold text-fg-3 uppercase tracking-wider">
									{t(statusKey(status))}
								</span>
								<span className="text-[0.625rem] text-fg-muted">
									{groupTasks.length}
								</span>
							</div>

							{/* Tasks in this status */}
							{groupTasks.map((task, idx) => {
								const isActive = task.id === activeTaskId;
								const bellCount = bellCounts.get(task.id) ?? 0;
								const displayTitle = getTaskTitle(task);
								const taskLabelIds = task.labelIds ?? [];
								const assignedLabels = taskLabelIds
									.map((id) => projectLabels.find((l) => l.id === id))
									.filter(Boolean) as typeof projectLabels;

								return (
									<div key={task.id}>
										{/* Dashed separator between tasks within the same group */}
										{idx > 0 && (
											<div className="mx-3 border-t border-dashed border-edge" />
										)}
										<button
											onClick={() => { closePreview(); handleTaskClick(task); }}
											onMouseEnter={(e) => handleTaskMouseEnter(task.id, e)}
											onMouseLeave={handleTaskMouseLeave}
											className={`w-full text-left px-3 py-2 transition-all border-l-2 relative ${
												isActive
													? "bg-accent/10 border-accent"
													: "border-transparent hover:bg-elevated-hover"
											}`}
										>
											{/* Bell badge */}
											{bellCount > 0 && (
												<div
													className="absolute top-1 right-2 min-w-[1rem] h-4 flex items-center justify-center px-1 rounded-full bg-red-500 shadow-sm shadow-red-500/40"
													title={t("task.bellTooltip")}
												>
													<span className="text-[0.5625rem] font-bold text-white leading-none">
														{bellCount > 9 ? "9+" : bellCount}
													</span>
												</div>
											)}

											{/* Seq number */}
											<div className="text-[0.5625rem] text-fg-muted font-mono mb-0.5">
												#{task.seq}
											</div>

											{/* Title */}
											<div className={`text-xs leading-snug break-words ${
												isActive ? "text-fg font-medium" : "text-fg-2"
											}`}>
												{displayTitle}
											</div>

											{/* Labels */}
											{assignedLabels.length > 0 && (
												<div className="flex flex-wrap gap-0.5 mt-1">
													{assignedLabels.map((label) => (
														<LabelChip
															key={label.id}
															label={label}
															size="xs"
														/>
													))}
												</div>
											)}
										</button>
									</div>
								);
							})}
						</div>
					))
				)}
			</div>

			{/* Terminal preview popover */}
			{previewOpen && createPortal(
				<div
					ref={previewRef}
					className="fixed z-50 rounded-xl shadow-2xl shadow-black/50 border border-edge-active overflow-hidden transition-opacity duration-150"
					style={{
						top: previewPos.top,
						left: previewPos.left,
						width: 420,
						maxHeight: 320,
						background: "#1a1a2e",
						opacity: previewHtml || previewLoading ? 1 : 0,
					}}
					onMouseEnter={cancelClose}
					onMouseLeave={scheduleClose}
					onClick={(e) => e.stopPropagation()}
				>
					{previewLoading ? (
						<div className="flex items-center justify-center h-20">
							<div className="w-4 h-4 border-2 border-fg-muted/30 border-t-fg-muted rounded-full animate-spin" />
						</div>
					) : previewHtml ? (
						<pre
							className="overflow-hidden m-0 p-2"
							style={{
								fontFamily: "monospace",
								fontSize: "5px",
								lineHeight: "6px",
								color: "#d3d7cf",
								whiteSpace: "pre",
								userSelect: "none",
							}}
							dangerouslySetInnerHTML={{ __html: previewHtml }}
						/>
					) : null}
				</div>,
				document.body
			)}
		</div>
	);
}

export default ActiveTasksSidebar;
