import { useState, useRef, useEffect, useLayoutEffect, useCallback, type Dispatch } from "react";
import { createPortal } from "react-dom";
import type { CodingAgent, Project, Task, TaskStatus } from "../../shared/types";
import { ACTIVE_STATUSES, STATUS_COLORS, getAllowedTransitions } from "../../shared/types";
import type { AppAction, Route } from "../state";
import { api } from "../rpc";
import { useT, statusKey } from "../i18n";
import { ansiToHtml } from "../utils/ansi-to-html";
import { trackEvent } from "../analytics";
import LabelChip from "./LabelChip";
import LabelPicker from "./LabelPicker";
import { confirmTaskCompletion } from "../utils/confirmTaskCompletion";
import TaskDetailModal from "./TaskDetailModal";

interface TaskCardProps {
	task: Task;
	project: Project;
	dispatch: Dispatch<AppAction>;
	navigate: (route: Route) => void;
	agents: CodingAgent[];
	onLaunchVariants: (task: Task, targetStatus: TaskStatus) => void;
	onDragStart: (taskId: string) => void;
	onTaskMoved: (taskId: string) => void;
	bellCount?: number;
	isActiveInSplit?: boolean;
}

function TaskCard({ task, project, dispatch, navigate, agents, onLaunchVariants, onDragStart: onDragStartProp, onTaskMoved, bellCount = 0, isActiveInSplit = false }: TaskCardProps) {
	const t = useT();
	const [moving, setMoving] = useState(false);
	const [menuOpen, setMenuOpen] = useState(false);
	const [menuPos, setMenuPos] = useState({ top: 0, left: 0 });
	const [menuVisible, setMenuVisible] = useState(false);
	const [detailOpen, setDetailOpen] = useState(false);
	const [pickerOpen, setPickerOpen] = useState(false);
	const pickerAnchorRef = useRef<HTMLButtonElement>(null);
	const menuRef = useRef<HTMLDivElement>(null);
	const triggerRef = useRef<HTMLButtonElement>(null);

	// Terminal preview state
	const [previewOpen, setPreviewOpen] = useState(false);
	const [previewHtml, setPreviewHtml] = useState<string | null>(null);
	const [previewLoading, setPreviewLoading] = useState(false);
	const [previewPos, setPreviewPos] = useState({ top: 0, left: 0 });
	const previewRef = useRef<HTMLDivElement>(null);
	const previewTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const previewCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const previewIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
	const cardRef = useRef<HTMLDivElement>(null);

	const isTodo = task.status === "todo";
	const isCancelled = task.status === "cancelled";
	const isActive = ACTIVE_STATUSES.includes(task.status);
	const color = STATUS_COLORS[task.status];

	// Close menu on click outside
	useEffect(() => {
		if (!menuOpen) return;
		function handleClick(e: MouseEvent) {
			if (
				menuRef.current &&
				!menuRef.current.contains(e.target as Node) &&
				triggerRef.current &&
				!triggerRef.current.contains(e.target as Node)
			) {
				setMenuOpen(false);
			}
		}
		document.addEventListener("mousedown", handleClick);
		return () => document.removeEventListener("mousedown", handleClick);
	}, [menuOpen]);

	// After menu renders (invisible), measure and clamp position within viewport
	useLayoutEffect(() => {
		if (!menuOpen || !menuRef.current || !triggerRef.current) return;

		const menu = menuRef.current.getBoundingClientRect();
		const trigger = triggerRef.current.getBoundingClientRect();
		const vw = window.innerWidth;
		const vh = window.innerHeight;
		const pad = 8;

		let top = trigger.bottom + 6;
		let left = trigger.left;

		// Flip above trigger if overflows bottom
		if (top + menu.height > vh - pad) {
			top = trigger.top - menu.height - 6;
		}
		// Clamp right edge
		if (left + menu.width > vw - pad) {
			left = vw - menu.width - pad;
		}
		// Clamp left edge
		if (left < pad) left = pad;
		// Clamp top edge
		if (top < pad) top = pad;

		setMenuPos({ top, left });
		setMenuVisible(true);
	}, [menuOpen]);

	function toggleMenu(e: React.MouseEvent) {
		e.stopPropagation();
		if (!menuOpen && triggerRef.current) {
			const rect = triggerRef.current.getBoundingClientRect();
			setMenuPos({ top: rect.bottom + 6, left: rect.left });
			setMenuVisible(false);
		}
		setMenuOpen(!menuOpen);
	}

	async function handleMove(newStatus: TaskStatus) {
		// Intercept: todo → active status opens the LaunchVariantsModal
		if (task.status === "todo" && ACTIVE_STATUSES.includes(newStatus)) {
			setMenuOpen(false);
			onLaunchVariants(task, newStatus);
			return;
		}

		// Warn before completing/cancelling with unpushed changes
		if (
			ACTIVE_STATUSES.includes(task.status) &&
			(newStatus === "completed" || newStatus === "cancelled")
		) {
			setMenuOpen(false);
			const proceed = await confirmTaskCompletion(task, project, newStatus, t);
			if (!proceed) return;
		}

		const fromStatus = task.status;
		setMoving(true);
		setMenuOpen(false);
		try {
			const updated = await api.request.moveTask({
				taskId: task.id,
				projectId: project.id,
				newStatus,
			});
			dispatch({ type: "updateTask", task: updated });
			onTaskMoved(task.id);
			trackEvent("task_moved", { from_status: fromStatus, to_status: newStatus });
		} catch (err) {
			// Auto-retry with force — environment is likely broken
			try {
				const updated = await api.request.moveTask({
					taskId: task.id,
					projectId: project.id,
					newStatus,
					force: true,
				});
				dispatch({ type: "updateTask", task: updated });
				onTaskMoved(task.id);
				trackEvent("task_moved", { from_status: fromStatus, to_status: newStatus });
			} catch (retryErr) {
				alert(t("task.failedMove", { error: String(retryErr) }));
			}
		}
		setMoving(false);
	}

	async function handleDelete() {
		setMenuOpen(false);
		const confirmed = await api.request.showConfirm({
			title: t("task.delete"),
			message: t("task.confirmDelete", { title: task.title }),
		});
		if (!confirmed) return;
		try {
			await api.request.deleteTask({
				taskId: task.id,
				projectId: project.id,
			});
			dispatch({ type: "removeTask", taskId: task.id });
			trackEvent("task_deleted", { project_id: project.id });
		} catch (err) {
			alert(t("task.failedDelete", { error: String(err) }));
		}
	}

	/** X button handler: cancel (from todo) or delete (from cancelled), with confirmation */
	async function handleDismiss(e: React.MouseEvent) {
		e.stopPropagation();
		if (isTodo) {
			const confirmed = await api.request.showConfirm({
				title: t("task.cancel"),
				message: t("task.confirmCancel", { title: task.title }),
			});
			if (!confirmed) return;
			handleMove("cancelled");
		} else if (isCancelled) {
			handleDelete();
		}
	}

	const isCompleted = task.status === "completed";

	function handleClick() {
		if (isActive && !menuOpen) {
			closePreview();
			if (isActiveInSplit) {
				// Toggle: clicking the already-active card closes the split
				navigate({ screen: "project", projectId: project.id });
			} else {
				navigate({
					screen: "project",
					projectId: project.id,
					activeTaskId: task.id,
				});
			}
		} else if ((isCompleted || isCancelled) && !menuOpen) {
			setDetailOpen(true);
		}
	}

	function handleDragStart(e: React.DragEvent) {
		e.dataTransfer.setData("text/plain", task.id);
		e.dataTransfer.effectAllowed = "move";
		onDragStartProp(task.id);
	}

	function handleTitleClick(e: React.MouseEvent) {
		if (isTodo) {
			e.stopPropagation();
			setDetailOpen(true);
		}
	}

	const hasLongDescription = task.description !== task.title;

	function handleShowDescription(e: React.MouseEvent) {
		e.stopPropagation();
		setDetailOpen(true);
	}

	// --- Terminal preview hover logic ---
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

	function handleCardMouseEnter() {
		if (!isActive || menuOpen) return;
		cancelPreviewTimers();
		previewTimerRef.current = setTimeout(async () => {
			if (!cardRef.current) return;
			const rect = cardRef.current.getBoundingClientRect();
			const vw = window.innerWidth;
			const vh = window.innerHeight;
			const popW = 420;
			const popH = 320;
			const pad = 8;

			let left = rect.right + 8;
			let top = rect.top;

			// Flip to left if overflows right
			if (left + popW > vw - pad) {
				left = rect.left - popW - 8;
			}
			// Clamp edges
			if (left < pad) left = pad;
			if (top + popH > vh - pad) {
				top = vh - popH - pad;
			}
			if (top < pad) top = pad;

			setPreviewPos({ top, left });
			setPreviewOpen(true);
			setPreviewLoading(true);

			try {
				const content = await api.request.getTerminalPreview({ taskId: task.id });
				if (content) {
					setPreviewHtml(ansiToHtml(content));
				} else {
					setPreviewHtml(null);
				}
			} catch {
				setPreviewHtml(null);
			}
			setPreviewLoading(false);

			// Refresh preview every second while open
			previewIntervalRef.current = setInterval(async () => {
				try {
					const content = await api.request.getTerminalPreview({ taskId: task.id });
					if (content) {
						setPreviewHtml(ansiToHtml(content));
					}
				} catch {
					// ignore refresh errors
				}
			}, 1000);
		}, 400);
	}

	function handleCardMouseLeave() {
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

	const showDismissButton = isTodo || isCancelled;

	return (
		<div
			ref={cardRef}
			draggable={!moving && !detailOpen}
			onDragStart={handleDragStart}
			onMouseEnter={handleCardMouseEnter}
			onMouseLeave={handleCardMouseLeave}
			className={`group relative p-3.5 glass-card rounded-xl transition-all border border-l-[3px] ${isActiveInSplit ? "border-accent/50 ring-2 ring-accent/30" : "border-transparent"} ${
				isActive || isCompleted || isCancelled
					? "cursor-pointer hover:-translate-y-0.5 hover:shadow-lg hover:shadow-black/25"
					: "cursor-grab active:cursor-grabbing hover:-translate-y-0.5 hover:shadow-lg hover:shadow-black/25"
			} ${moving ? "opacity-50 pointer-events-none" : ""}`}
			style={{ borderLeftColor: color }}
			onClick={handleClick}
		>
			{/* Dismiss button — top-right, visible on hover */}
			{showDismissButton && (
				<button
					onClick={handleDismiss}
					className="absolute top-2.5 right-2.5 opacity-0 group-hover:opacity-100 w-5 h-5 flex items-center justify-center rounded-md bg-fg/5 text-fg-3 hover:bg-danger/15 hover:text-danger transition-all"
					title={isCancelled ? t("task.delete") : t("task.cancel")}
					disabled={moving}
				>
					<svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
						<path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
					</svg>
				</button>
			)}

			{/* Bell badge — macOS Dock style, peeking outside the card */}
			{bellCount > 0 && (
				<div
					className="absolute -top-1.5 -right-1.5 z-10 min-w-[20px] h-5 flex items-center justify-center px-1.5 rounded-full bg-red-500 shadow-lg shadow-red-500/40"
					title={t("task.bellTooltip")}
				>
					<span className="text-[11px] font-bold text-white leading-none">
						{bellCount > 9 ? "9+" : bellCount}
					</span>
				</div>
			)}

			{/* Seq + variant badge */}
			{task.variantIndex !== null ? (() => {
				const agent = task.agentId ? agents.find((a) => a.id === task.agentId) : null;
				const config = agent && task.configId
					? agent.configurations.find((c) => c.id === task.configId)
					: agent?.configurations.find((c) => c.id === agent.defaultConfigId) ?? agent?.configurations[0];

				let label = `#${task.seq} · ${t("task.attempt", { n: String(task.variantIndex) })}`;
				if (agent) {
					label += ` · ${agent.name}`;
					if (config) {
						label += config.model
							? ` (${config.name} · ${config.model})`
							: ` (${config.name})`;
					}
				}
				return (
					<div className="text-xs text-accent font-semibold mb-1.5 flex items-center gap-1.5">
						<span className="bg-accent/15 px-2 py-0.5 rounded-md">{label}</span>
					</div>
				);
			})() : (
				<div className="text-[10px] text-fg-muted font-mono mb-1">#{task.seq}</div>
			)}

			{/* Title + description expand */}
			<div
				className={`text-fg text-sm leading-relaxed break-words font-medium pr-5 ${isTodo ? "cursor-pointer hover:text-fg-2" : ""}`}
				onClick={handleTitleClick}
				title={isTodo && hasLongDescription ? task.description : undefined}
			>
				{task.title}
			</div>
			{hasLongDescription && !isTodo && (
				<button
					onClick={handleShowDescription}
					className="mt-1 text-[11px] text-fg-muted hover:text-accent transition-colors flex items-center gap-1"
					title={t("task.showDescription")}
				>
					<svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
						<path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h10" />
					</svg>
					{t("task.showDescription")}
				</button>
			)}

			{/* Task detail modal — portal to body so it's not clipped by card */}
			{detailOpen && createPortal(
				<TaskDetailModal
					task={task}
					project={project}
					dispatch={dispatch}
					onClose={() => setDetailOpen(false)}
				/>,
				document.body
			)}

			{/* Label chips row — always rendered so "+" is discoverable on hover */}
			{(() => {
				const projectLabels = project.labels ?? [];
				const taskLabelIds = task.labelIds ?? [];
				const assignedLabels = taskLabelIds
					.map((id) => projectLabels.find((l) => l.id === id))
					.filter(Boolean) as typeof projectLabels;

				async function removeLabel(labelId: string) {
					try {
						const updated = await api.request.setTaskLabels({
							taskId: task.id,
							projectId: project.id,
							labelIds: taskLabelIds.filter((id) => id !== labelId),
						});
						dispatch({ type: "updateTask", task: updated });
					} catch {
						// ignore
					}
				}

				return (
					<div className="flex items-center flex-wrap gap-1 mt-2 min-h-[18px]">
						{assignedLabels.map((label) => (
							<LabelChip
								key={label.id}
								label={label}
								size="xs"
								onClick={(e) => {
									e.stopPropagation();
									setPickerOpen(true);
								}}
								onRemove={(e) => {
									e.stopPropagation();
									removeLabel(label.id);
								}}
							/>
						))}
						<button
							ref={pickerAnchorRef}
							type="button"
							onClick={(e) => {
								e.stopPropagation();
								setPickerOpen(true);
							}}
							className="opacity-0 group-hover:opacity-70 hover:!opacity-100 flex items-center gap-1 px-1.5 py-0.5 rounded-md text-fg-3 hover:text-fg hover:bg-fg/8 transition-all flex-shrink-0"
						>
							<svg className="w-2.5 h-2.5 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
								<path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
							</svg>
							<span className="text-[10px] font-medium leading-none">Add label</span>
						</button>
						{pickerOpen && pickerAnchorRef.current && (
							<LabelPicker
								project={project}
								task={task}
								dispatch={dispatch}
								onClose={() => setPickerOpen(false)}
								anchorEl={pickerAnchorRef.current}
							/>
						)}
					</div>
				);
			})()}

			{/* Bottom row */}
			<div className="flex items-center justify-between mt-3 gap-2">
				{/* Status dropdown trigger */}
				<button
					ref={triggerRef}
					onClick={toggleMenu}
					className="flex items-center gap-2 px-2 py-1 rounded-lg hover:bg-fg/5 transition-colors flex-shrink-0"
					disabled={moving}
				>
					<div
						className="w-2 h-2 rounded-full flex-shrink-0"
						style={{ background: color }}
					/>
					<span className="text-xs text-fg-2">
						{t(statusKey(task.status))}
					</span>
				</button>

				{/* Right side actions */}
				{isTodo ? (
					/* Run button for TODO cards */
					<button
						onClick={(e) => {
							e.stopPropagation();
							onLaunchVariants(task, "in-progress");
						}}
						className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg bg-green-600 hover:bg-green-500 text-white shadow-sm shadow-green-900/30 transition-colors"
						title={t("task.run")}
						disabled={moving}
					>
						<svg className="w-3 h-3" fill="currentColor" viewBox="0 0 24 24">
							<path d="M8 5v14l11-7z" />
						</svg>
						{t("task.run")}
					</button>
				) : null}
			</div>

			{/* Status dropdown menu — portal + smart viewport clamping */}
			{menuOpen && createPortal(
				<div
					ref={menuRef}
					className="fixed z-50 bg-overlay rounded-xl shadow-2xl shadow-black/40 border border-edge-active py-1.5 min-w-[180px]"
					style={{
						top: menuPos.top,
						left: menuPos.left,
						visibility: menuVisible ? "visible" : "hidden",
					}}
					onClick={(e) => e.stopPropagation()}
				>
					<div className="px-3 py-2 text-xs text-fg-3 uppercase tracking-wider font-semibold">
						{t("task.moveTo")}
					</div>
					{getAllowedTransitions(task.status).map((s) => (
						<button
							key={s}
							onClick={() => handleMove(s)}
							className="w-full text-left px-3 py-2 text-sm text-fg-2 hover:bg-elevated-hover hover:text-fg flex items-center gap-2.5 transition-colors"
						>
							<div
								className="w-2.5 h-2.5 rounded-full flex-shrink-0"
								style={{ background: STATUS_COLORS[s] }}
							/>
							{t(statusKey(s))}
						</button>
					))}
					{isCancelled && (
						<div className="border-t border-edge-active mt-1.5 pt-1.5">
							<button
								onClick={handleDelete}
								className="w-full text-left px-3 py-2 text-sm text-danger hover:bg-danger/10 flex items-center gap-2.5 transition-colors"
							>
								<svg
									className="w-4 h-4 flex-shrink-0"
									fill="none"
									stroke="currentColor"
									viewBox="0 0 24 24"
								>
									<path
										strokeLinecap="round"
										strokeLinejoin="round"
										strokeWidth={2}
										d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
									/>
								</svg>
								{t("task.delete")}
							</button>
						</div>
					)}
				</div>,
				document.body
			)}

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

export default TaskCard;
