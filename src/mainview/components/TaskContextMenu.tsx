import { useEffect, useLayoutEffect, useRef, useState, type Dispatch, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { Project, Task, TaskPriority, TaskStatus } from "../../shared/types";
import { getTaskTitle, isTaskDisconnected } from "../../shared/types";
import type { AppAction } from "../state";
import { api } from "../rpc";
import { confirm } from "../confirm";
import { toast } from "../toast";
import { useT } from "../i18n";
import { trackEvent, agentNameFromId } from "../analytics";
import { useNarrowViewport } from "../hooks/useNarrowViewport";
import { useOverlayLayer } from "../utils/useOverlayLayer";
import { moveTaskToStatus } from "../utils/moveTaskToStatus";
import { buildTaskDeepLink } from "../../shared/deep-link";
import { formatBytes } from "../utils/formatBytes";
import BottomSheet from "./BottomSheet";
import LabelPicker from "./LabelPicker";
import MoveToProjectPicker from "./MoveToProjectPicker";
import OpenInMenu from "./OpenInMenu";
import PipelineDropdown from "./PipelineDropdown";
import PriorityPicker from "./PriorityPicker";
import TaskDetailModal from "./TaskDetailModal";
import { CAROUSEL_MAX_WIDTH } from "./MobileBoardCarousel";

/** Which nested picker the menu handed off to, if any. */
type SubSurface = "labels" | "priority" | "status" | "project" | "openIn";

interface TaskContextMenuProps {
	task: Task;
	/** The task's OWN project — labels, columns and the move source resolve against it. */
	project: Project;
	dispatch: Dispatch<AppAction>;
	/** Cursor position the menu opens at; null keeps it closed. */
	pos: { x: number; y: number } | null;
	onClose: () => void;
	/** Opens the task's workspace — the row/card's own navigation. */
	onOpenTask: () => void;
	/** Surfaces that already own a detail modal pass theirs; otherwise one is rendered here. */
	onOpenDetails?: () => void;
	testId?: string;
}

interface MenuRow {
	id: string;
	label: string;
	onSelect: () => void;
	/** Opens a nested picker — gets the ▸ affordance. */
	submenu?: boolean;
	danger?: boolean;
	disabled?: boolean;
	/** Toggle state marker for Watch / Hidden. */
	checked?: boolean;
}

/**
 * Right-click actions for one task, shared by the Kanban card and the Active
 * Tasks sidebar row. The menu itself only routes: every action it offers is the
 * existing picker, modal or RPC the object already had elsewhere.
 */
export default function TaskContextMenu({
	task,
	project,
	dispatch,
	pos,
	onClose,
	onOpenTask,
	onOpenDetails,
	testId,
}: TaskContextMenuProps) {
	const t = useT();
	const narrow = useNarrowViewport(CAROUSEL_MAX_WIDTH);
	const [sub, setSub] = useState<SubSurface | null>(null);
	// Pickers anchor to an element, so the cursor point becomes a 0×0 one.
	const [anchorPos, setAnchorPos] = useState({ x: 0, y: 0 });
	const [anchorEl, setAnchorEl] = useState<HTMLDivElement | null>(null);
	const [detailOpen, setDetailOpen] = useState(false);
	const [autoRename, setAutoRename] = useState(false);

	const labelIds = task.labelIds ?? [];
	const disconnected = isTaskDisconnected(task);
	const hasSession = !!task.worktreePath && !task.hibernated && !task.preparing && !task.shuttingDown && !disconnected;

	function openSub(next: SubSurface) {
		if (pos) setAnchorPos(pos);
		setAnchorEl(null);
		setSub(next);
		onClose();
	}

	function closeSub() {
		setSub(null);
		setAnchorEl(null);
	}

	function openDetails(rename: boolean) {
		onClose();
		setAutoRename(rename);
		if (onOpenDetails && !rename) {
			onOpenDetails();
			return;
		}
		setDetailOpen(true);
	}

	function copy(text: string) {
		navigator.clipboard.writeText(text);
		toast.success(t("taskMenu.copied"), { taskId: task.id });
		onClose();
	}

	async function handleToggleLabel(labelId: string) {
		const next = labelIds.includes(labelId) ? labelIds.filter((id) => id !== labelId) : [...labelIds, labelId];
		try {
			const updated = await api.request.setTaskLabels({ taskId: task.id, projectId: project.id, labelIds: next });
			dispatch({ type: "updateTask", task: updated });
		} catch (err) {
			toast.error(t("labels.failedSetLabels", { error: String(err) }), { taskId: task.id });
		}
	}

	async function handlePriority(priority: TaskPriority) {
		closeSub();
		try {
			const changed = await api.request.setTaskPriority({ taskId: task.id, projectId: project.id, priority });
			for (const changedTask of changed) dispatch({ type: "updateTask", task: changedTask });
		} catch (err) {
			toast.error(t("priority.failedSet", { error: String(err) }), { taskId: task.id });
		}
	}

	async function handleMove(newStatus: TaskStatus) {
		closeSub();
		await moveTaskToStatus({ task, project, newStatus, dispatch, t, onOpenTask });
	}

	async function handleMoveToCustomColumn(customColumnId: string) {
		closeSub();
		try {
			const updated = await api.request.moveTaskToCustomColumn({ taskId: task.id, projectId: project.id, customColumnId });
			dispatch({ type: "updateTask", task: updated });
			trackEvent("task_moved", {
				from_status: task.status,
				to_status: `custom:${customColumnId}`,
				agent_name: agentNameFromId(task.agentId),
			});
		} catch (err) {
			toast.error(t("task.failedMove", { error: String(err) }), { taskId: task.id });
		}
	}

	async function handleMoveToProject(target: Project) {
		closeSub();
		try {
			await api.request.moveTaskToProject({ taskId: task.id, fromProjectId: project.id, toProjectId: target.id });
			dispatch({ type: "removeTask", taskId: task.id });
			trackEvent("task_moved_to_project", { from_project_id: project.id, to_project_id: target.id });
			toast.success(t("task.movedToProject", { project: target.name }));
		} catch (err) {
			toast.error(t("task.failedMoveToProject", { error: String(err) }), { taskId: task.id });
		}
	}

	async function handleToggleWatch() {
		onClose();
		try {
			const updated = await api.request.toggleTaskWatch({ taskId: task.id, projectId: project.id, watched: !task.watched });
			dispatch({ type: "updateTask", task: updated });
		} catch (err) {
			toast.error(t("task.watchFailed", { error: String(err) }), { taskId: task.id });
		}
	}

	async function handleToggleHidden() {
		onClose();
		try {
			const changed = await api.request.setTaskHidden({ taskId: task.id, projectId: project.id, hidden: !task.hidden });
			for (const changedTask of changed) dispatch({ type: "updateTask", task: changedTask });
		} catch (err) {
			toast.error(t("task.hiddenFailed", { error: String(err) }), { taskId: task.id });
		}
	}

	async function handleHibernate() {
		onClose();
		const paneCount = task.sessionState?.panes?.length ?? 0;
		const confirmed = await confirm({
			title: t("task.hibernateConfirmTitle"),
			message:
				paneCount > 1
					? `${t("task.hibernateConfirmBody")}\n\n${t("task.hibernateConfirmMulti", { count: String(paneCount) })}`
					: t("task.hibernateConfirmBody"),
			confirmLabel: t("task.hibernateConfirmCta"),
			danger: true,
			info: { title: getTaskTitle(task) },
		});
		if (!confirmed) return;
		try {
			const { task: updated, freedRssBytes } = await api.request.hibernateTask({ taskId: task.id, projectId: project.id });
			dispatch({ type: "updateTask", task: updated });
			toast.success(
				freedRssBytes ? t("task.hibernatedToastMem", { mem: formatBytes(freedRssBytes) }) : t("task.hibernatedToast"),
				{ taskId: task.id },
			);
		} catch (err) {
			toast.error(t("task.hibernateFailed", { error: String(err) }), { taskId: task.id });
		}
	}

	async function handleDelete() {
		onClose();
		const confirmed = await confirm({
			title: t("task.delete"),
			message: t("task.confirmDelete", { title: getTaskTitle(task) }),
			confirmLabel: t("task.deleteConfirmLabel"),
			danger: true,
		});
		if (!confirmed) return;
		try {
			await api.request.deleteTask({ taskId: task.id, projectId: project.id });
			dispatch({ type: "removeTask", taskId: task.id });
			trackEvent("task_deleted", { project_id: project.id });
		} catch (err) {
			toast.error(t("task.failedDelete", { error: String(err) }), { taskId: task.id });
		}
	}

	const groups: MenuRow[][] = [
		[
			{ id: "open", label: t("taskMenu.open"), onSelect: () => { onClose(); onOpenTask(); } },
			{ id: "details", label: t("taskMenu.details"), onSelect: () => openDetails(false) },
		],
		[
			{ id: "labels", label: t("taskMenu.labels"), onSelect: () => openSub("labels"), submenu: true },
			{ id: "priority", label: t("taskMenu.priority"), onSelect: () => openSub("priority"), submenu: true },
			{ id: "status", label: t("task.moveTo"), onSelect: () => openSub("status"), submenu: true },
			{ id: "project", label: t("task.moveToProject"), onSelect: () => openSub("project") },
			{ id: "rename", label: t("taskMenu.rename"), onSelect: () => openDetails(true) },
		],
		[
			{
				id: "openIn",
				label: t("openIn.menuTitle"),
				onSelect: () => openSub("openIn"),
				submenu: true,
				disabled: !task.worktreePath,
			},
			{ id: "copyLink", label: t("taskMenu.copyLink"), onSelect: () => copy(buildTaskDeepLink(task.id)) },
			{
				id: "copyBranch",
				label: t("taskMenu.copyBranch"),
				onSelect: () => copy(task.branchName ?? ""),
				disabled: !task.branchName,
			},
			{
				id: "copyPath",
				label: t("taskMenu.copyPath"),
				onSelect: () => copy(task.worktreePath ?? ""),
				disabled: !task.worktreePath,
			},
		],
		[
			{
				id: "watch",
				label: task.watched ? t("task.unwatchTooltip") : t("task.watch"),
				onSelect: handleToggleWatch,
				checked: task.watched,
			},
			{
				id: "hidden",
				label: task.hidden ? t("task.showInSidebar") : t("task.hideFromSidebar"),
				onSelect: handleToggleHidden,
				checked: task.hidden,
			},
			{ id: "hibernate", label: t("task.hibernate"), onSelect: handleHibernate, disabled: !hasSession },
		],
		[{ id: "delete", label: t("taskMenu.delete"), onSelect: handleDelete, danger: true }],
	];

	const rows: ReactNode[] = [];
	groups.forEach((group, groupIndex) => {
		if (groupIndex > 0) rows.push(<div key={`sep-${groupIndex}`} className="my-1 border-t border-edge" />);
		for (const row of group) {
			rows.push(
				<button
					key={row.id}
					type="button"
					role="menuitem"
					disabled={row.disabled}
					data-testid={`task-menu-${row.id}`}
					onClick={(e) => {
						e.stopPropagation();
						row.onSelect();
					}}
					className={`flex w-full items-center gap-2 px-3 text-left transition-colors disabled:opacity-40 disabled:pointer-events-none ${
						narrow ? "py-3 text-sm-plus" : "py-1.5 text-sm"
					} ${row.danger ? "text-danger hover:bg-danger/10" : "text-fg-2 hover:bg-elevated-hover hover:text-fg"}`}
				>
					<span aria-hidden className="w-3 flex-shrink-0 text-center text-xs leading-none text-accent">
						{row.checked ? "✓" : ""}
					</span>
					<span className="min-w-0 flex-1 truncate">{row.label}</span>
					{row.submenu && (
						<span aria-hidden className="flex-shrink-0 text-xs leading-none text-fg-muted">
							{"▸"}
						</span>
					)}
				</button>,
			);
		}
	});

	const menu = pos ? (
		narrow ? (
			<div onClick={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()}>
				<BottomSheet open onClose={onClose} title={t("taskMenu.title")} testId={testId}>
					<div role="menu">{rows}</div>
				</BottomSheet>
			</div>
		) : (
			<MenuPanel pos={pos} label={t("taskMenu.title")} testId={testId} onClose={onClose}>
				{rows}
			</MenuPanel>
		)
	) : null;

	return (
		<>
			{menu}
			{sub &&
				createPortal(
					<div ref={setAnchorEl} className="fixed h-0 w-0" style={{ top: anchorPos.y, left: anchorPos.x }} />,
					document.body,
				)}
			{sub === "labels" && anchorEl && (
				<LabelPicker
					project={project}
					dispatch={dispatch}
					taskId={task.id}
					anchorEl={anchorEl}
					selectedIds={labelIds}
					onToggle={handleToggleLabel}
					onClose={closeSub}
				/>
			)}
			{sub === "priority" && anchorEl && (
				<PriorityPicker selected={task.priority} anchorEl={anchorEl} onSelect={handlePriority} onClose={closeSub} />
			)}
			{sub === "project" && anchorEl && (
				<MoveToProjectPicker
					currentProjectId={project.id}
					anchorEl={anchorEl}
					onSelect={handleMoveToProject}
					onClose={closeSub}
				/>
			)}
			{sub === "openIn" && task.worktreePath && (
				<OpenInMenu
					position={{ top: anchorPos.y, left: anchorPos.x }}
					path={task.worktreePath}
					taskId={task.id}
					onClose={closeSub}
				/>
			)}
			{sub === "status" &&
				(narrow ? (
					<BottomSheet open onClose={closeSub} title={t("task.moveTo")} testId={`task-menu-status-sheet-${task.id}`}>
						<PipelineDropdown
							currentStatus={task.status}
							onMove={handleMove}
							onMoveToCustomColumn={handleMoveToCustomColumn}
							customColumns={project.customColumns}
							currentCustomColumnId={task.customColumnId}
							project={project}
							size="touch"
							hideHeader
						/>
					</BottomSheet>
				) : (
					createPortal(
						<div
							className="fixed z-[10000] min-w-[11.25rem] rounded-xl border border-edge-active bg-overlay py-1.5 shadow-2xl shadow-black/40"
							style={clampToViewport(anchorPos)}
							onClick={(e) => e.stopPropagation()}
						>
							<PipelineDropdown
								currentStatus={task.status}
								onMove={handleMove}
								onMoveToCustomColumn={handleMoveToCustomColumn}
								customColumns={project.customColumns}
								currentCustomColumnId={task.customColumnId}
								project={project}
							/>
							{/* Click-outside for a panel with no anchor of its own. */}
							<div className="fixed inset-0 -z-10" onClick={closeSub} onContextMenu={closeSub} />
						</div>,
						document.body,
					)
				))}
			{/* Portalled: the sidebar column clips a modal rendered in place. */}
			{detailOpen &&
				createPortal(
					<TaskDetailModal
						task={task}
						project={project}
						dispatch={dispatch}
						autoRename={autoRename}
						onClose={() => {
							setDetailOpen(false);
							setAutoRename(false);
						}}
						onOpenTask={onOpenTask}
					/>,
					document.body,
				)}
		</>
	);
}

/**
 * The desktop panel, mounted only while open: `useOverlayLayer` registers on
 * mount, so a panel that merely appears inside a long-lived component would
 * never reach the Escape/Tab stack.
 */
function MenuPanel({
	pos,
	label,
	testId,
	onClose,
	children,
}: {
	pos: { x: number; y: number };
	label: string;
	testId?: string;
	onClose: () => void;
	children: ReactNode;
}) {
	const panelRef = useRef<HTMLDivElement>(null);
	const [menuPos, setMenuPos] = useState({ top: 0, left: 0 });
	const [measured, setMeasured] = useState(false);

	useOverlayLayer(panelRef, { onDismiss: onClose });

	// Land on the first row once the panel is visible — a hidden element takes no
	// focus, and until then the arrow keys below have nothing to move from.
	useEffect(() => {
		if (measured) items()[0]?.focus();
	}, [measured]);

	function items(): HTMLButtonElement[] {
		return [...(panelRef.current?.querySelectorAll<HTMLButtonElement>("button:not([disabled])") ?? [])];
	}

	function onKeyDown(e: React.KeyboardEvent) {
		if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
		e.preventDefault();
		const all = items();
		const at = all.indexOf(document.activeElement as HTMLButtonElement);
		const next = e.key === "ArrowDown" ? at + 1 : at - 1;
		all[(next + all.length) % all.length]?.focus();
	}

	// Render at the cursor first, then flip the panel back inside the window.
	useLayoutEffect(() => {
		const el = panelRef.current;
		if (!el) return;
		const rect = el.getBoundingClientRect();
		const pad = 8;
		let top = pos.y;
		let left = pos.x;
		if (top + rect.height > window.innerHeight - pad) top = Math.max(pad, window.innerHeight - rect.height - pad);
		if (left + rect.width > window.innerWidth - pad) left = Math.max(pad, window.innerWidth - rect.width - pad);
		setMenuPos({ top, left });
		setMeasured(true);
	}, [pos]);

	useEffect(() => {
		function onPointerDown(e: MouseEvent) {
			if (!panelRef.current?.contains(e.target as Node)) onClose();
		}
		document.addEventListener("mousedown", onPointerDown);
		return () => document.removeEventListener("mousedown", onPointerDown);
	}, [onClose]);

	return createPortal(
		<div
			ref={panelRef}
			role="menu"
			aria-label={label}
			data-testid={testId}
			className="fixed z-[10000] min-w-[13rem] max-w-[18rem] rounded-xl border border-edge-active bg-overlay py-1.5 shadow-2xl shadow-black/40"
			style={measured ? { top: menuPos.top, left: menuPos.left } : { top: pos.y, left: pos.x, visibility: "hidden" }}
			onClick={(e) => e.stopPropagation()}
			onContextMenu={(e) => e.preventDefault()}
			onKeyDown={onKeyDown}
		>
			{children}
		</div>,
		document.body,
	);
}

/** Keeps a cursor-positioned panel inside the window; measured panels clamp again themselves. */
function clampToViewport(pos: { x: number; y: number }): { top: number; left: number } {
	const pad = 8;
	const maxLeft = Math.max(pad, window.innerWidth - 240 - pad);
	const maxTop = Math.max(pad, window.innerHeight - 360 - pad);
	return { top: Math.min(pos.y, maxTop), left: Math.min(pos.x, maxLeft) };
}
