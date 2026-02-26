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
	const [isEditing, setIsEditing] = useState(false);
	const [editValue, setEditValue] = useState("");
	const [saving, setSaving] = useState(false);
	const menuRef = useRef<HTMLDivElement>(null);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const textareaRef = useRef<HTMLTextAreaElement>(null);

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

	function handleTitleClick(e: React.MouseEvent) {
		if (!isTodo || isEditing) return;
		e.stopPropagation();
		setEditValue(task.description);
		setIsEditing(true);
		// autofocus after state update
		setTimeout(() => textareaRef.current?.focus(), 0);
	}

	async function handleEditSave() {
		const trimmed = editValue.trim();
		if (!trimmed || trimmed === task.description) {
			setIsEditing(false);
			return;
		}
		setSaving(true);
		try {
			const updated = await api.request.editTask({
				taskId: task.id,
				projectId: project.id,
				description: trimmed,
			});
			dispatch({ type: "updateTask", task: updated });
			setIsEditing(false);
		} catch (err) {
			alert(t("task.failedEdit", { error: String(err) }));
		}
		setSaving(false);
	}

	function handleEditCancel() {
		setIsEditing(false);
	}

	function handleEditKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
		if (e.key === "Escape") {
			e.preventDefault();
			handleEditCancel();
		} else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
			e.preventDefault();
			handleEditSave();
		}
	}

	const showDismissButton = isTodo || isCancelled;

	return (
		<div
			draggable={!moving && !isEditing}
			onDragStart={handleDragStart}
			className={`group relative p-3.5 glass-card rounded-xl transition-all border border-transparent border-l-[3px] ${
				isActive
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

			{/* Title / inline editor */}
			{isEditing ? (
				<div className="mt-0.5" onClick={(e) => e.stopPropagation()}>
					<textarea
						ref={textareaRef}
						value={editValue}
						onChange={(e) => setEditValue(e.target.value)}
						onKeyDown={handleEditKeyDown}
						rows={3}
						className="w-full bg-elevated border border-edge-active rounded-lg px-2.5 py-2 text-sm text-fg leading-relaxed resize-none outline-none focus:border-accent/60 transition-colors"
						disabled={saving}
					/>
					<div className="flex items-center justify-between mt-1.5">
						<span className="text-xs text-fg-muted">{t("task.editHint")}</span>
						<div className="flex gap-1.5">
							<button
								onClick={handleEditCancel}
								className="text-xs px-2.5 py-1 rounded-lg text-fg-2 hover:bg-fg/8 transition-colors"
								disabled={saving}
							>
								{t("task.editCancel")}
							</button>
							<button
								onClick={handleEditSave}
								className="text-xs px-2.5 py-1 rounded-lg bg-accent text-white hover:bg-accent-hover font-semibold transition-colors disabled:opacity-50"
								disabled={saving || !editValue.trim()}
							>
								{t("task.editSave")}
							</button>
						</div>
					</div>
				</div>
			) : (
				<div
					className={`text-fg text-sm leading-relaxed break-words font-medium pr-5 ${isTodo ? "cursor-text hover:text-fg-2" : ""}`}
					onClick={handleTitleClick}
					title={isTodo ? task.description : undefined}
				>
					{task.title}
				</div>
			)}

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
				</div>
			)}
		</div>
	);
}

export default TaskCard;
