import { useState, useRef, useEffect, type Dispatch } from "react";
import type { CodingAgent, Project, Task, TaskStatus } from "../../shared/types";
import { ACTIVE_STATUSES, STATUS_COLORS, getAllowedTransitions } from "../../shared/types";
import type { AppAction, Route } from "../state";
import { api } from "../rpc";
import { useT, statusKey } from "../i18n";

interface TaskCardProps {
	task: Task;
	project: Project;
	dispatch: Dispatch<AppAction>;
	navigate: (route: Route) => void;
	agents: CodingAgent[];
	onLaunchVariants: (task: Task, targetStatus: TaskStatus) => void;
	onDragStart: (taskId: string) => void;
}

function TaskCard({ task, project, dispatch, navigate, agents, onLaunchVariants, onDragStart: onDragStartProp }: TaskCardProps) {
	const t = useT();
	const [moving, setMoving] = useState(false);
	const [menuOpen, setMenuOpen] = useState(false);
	const [menuPos, setMenuPos] = useState({ top: 0, left: 0 });
	const menuRef = useRef<HTMLDivElement>(null);
	const triggerRef = useRef<HTMLButtonElement>(null);

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

	function toggleMenu(e: React.MouseEvent) {
		e.stopPropagation();
		if (!menuOpen && triggerRef.current) {
			const rect = triggerRef.current.getBoundingClientRect();
			setMenuPos({ top: rect.bottom + 6, left: rect.left });
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

		setMoving(true);
		setMenuOpen(false);
		try {
			const updated = await api.request.moveTask({
				taskId: task.id,
				projectId: project.id,
				newStatus,
			});
			dispatch({ type: "updateTask", task: updated });
		} catch (err) {
			alert(t("task.failedMove", { error: String(err) }));
		}
		setMoving(false);
	}

	async function handleDelete() {
		setMenuOpen(false);
		if (!confirm(t("task.confirmDelete", { title: task.title }))) return;
		try {
			await api.request.deleteTask({
				taskId: task.id,
				projectId: project.id,
			});
			dispatch({ type: "removeTask", taskId: task.id });
		} catch (err) {
			alert(t("task.failedDelete", { error: String(err) }));
		}
	}

	/** X button handler: cancel (from todo) or delete (from cancelled), with confirmation */
	function handleDismiss(e: React.MouseEvent) {
		e.stopPropagation();
		if (isTodo) {
			if (!confirm(t("task.confirmCancel", { title: task.title }))) return;
			handleMove("cancelled");
		} else if (isCancelled) {
			handleDelete();
		}
	}

	function handleClick() {
		if (isActive && !menuOpen) {
			navigate({
				screen: "task",
				projectId: project.id,
				taskId: task.id,
			});
		}
	}

	function handleDragStart(e: React.DragEvent) {
		e.dataTransfer.setData("text/plain", task.id);
		e.dataTransfer.effectAllowed = "move";
		onDragStartProp(task.id);
	}

	const showDismissButton = isTodo || isCancelled;

	return (
		<div
			draggable={!moving}
			onDragStart={handleDragStart}
			className={`group relative p-3.5 bg-elevated rounded-xl transition-all border-l-[3px] ${
				isActive
					? "cursor-pointer hover:bg-elevated-hover hover:shadow-lg hover:shadow-black/15"
					: "cursor-grab active:cursor-grabbing"
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

			{/* Variant badge */}
			{task.variantIndex !== null && (() => {
				const agent = task.agentId ? agents.find((a) => a.id === task.agentId) : null;
				const config = agent && task.configId
					? agent.configurations.find((c) => c.id === task.configId)
					: agent?.configurations.find((c) => c.id === agent.defaultConfigId) ?? agent?.configurations[0];

				let label = `#${task.variantIndex}`;
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
			})()}

			{/* Title */}
			<div className="text-fg text-sm leading-relaxed break-words font-medium pr-5">
				{task.title}
			</div>

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
				) : !showDismissButton && (
					/* Delete button for non-todo/non-cancelled cards (visible on hover) */
					<button
						onClick={(e) => {
							e.stopPropagation();
							handleDelete();
						}}
						className="opacity-0 group-hover:opacity-100 text-fg-muted hover:text-danger transition-all p-1 rounded-lg hover:bg-danger/10"
						title={t("task.delete")}
					>
						<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
							<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
						</svg>
					</button>
				)}
			</div>

			{/* Status dropdown menu */}
			{menuOpen && (
				<div
					ref={menuRef}
					className="fixed z-50 bg-overlay rounded-xl shadow-2xl shadow-black/40 border border-edge-active py-1.5 min-w-[180px]"
					style={{ top: menuPos.top, left: menuPos.left }}
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
				</div>
			)}
		</div>
	);
}

export default TaskCard;
