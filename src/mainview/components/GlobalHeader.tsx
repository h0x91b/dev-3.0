import { Fragment, useState, useRef, useEffect, useLayoutEffect, type Dispatch } from "react";
import { createPortal } from "react-dom";
import type { Project, Task, TaskStatus } from "../../shared/types";
import { ACTIVE_STATUSES, STATUS_COLORS, getAllowedTransitions } from "../../shared/types";
import type { AppAction, Route } from "../state";
import { api } from "../rpc";
import { useT, statusKey } from "../i18n";

interface GlobalHeaderProps {
	route: Route;
	projects: Project[];
	tasks: Task[];
	navigate: (route: Route) => void;
	dispatch: Dispatch<AppAction>;
}

interface BreadcrumbSegment {
	label: string;
	onClick?: () => void;
}

function GlobalHeader({ route, projects, tasks, navigate, dispatch }: GlobalHeaderProps) {
	const t = useT();
	const segments: BreadcrumbSegment[] = [];

	// Status dropdown state (for task screen)
	const [statusMenuOpen, setStatusMenuOpen] = useState(false);
	const [statusMenuPos, setStatusMenuPos] = useState({ top: 0, left: 0 });
	const [statusMenuVisible, setStatusMenuVisible] = useState(false);
	const [movingStatus, setMovingStatus] = useState(false);
	const statusTriggerRef = useRef<HTMLButtonElement>(null);
	const statusMenuRef = useRef<HTMLDivElement>(null);

	// Close status menu on click outside
	useEffect(() => {
		if (!statusMenuOpen) return;
		function handleClick(e: MouseEvent) {
			if (
				statusMenuRef.current &&
				!statusMenuRef.current.contains(e.target as Node) &&
				statusTriggerRef.current &&
				!statusTriggerRef.current.contains(e.target as Node)
			) {
				setStatusMenuOpen(false);
			}
		}
		document.addEventListener("mousedown", handleClick);
		return () => document.removeEventListener("mousedown", handleClick);
	}, [statusMenuOpen]);

	// Smart viewport clamping for status menu
	useLayoutEffect(() => {
		if (!statusMenuOpen || !statusMenuRef.current || !statusTriggerRef.current) return;

		const menu = statusMenuRef.current.getBoundingClientRect();
		const trigger = statusTriggerRef.current.getBoundingClientRect();
		const vw = window.innerWidth;
		const vh = window.innerHeight;
		const pad = 8;

		let top = trigger.bottom + 6;
		let left = trigger.left;

		if (top + menu.height > vh - pad) {
			top = trigger.top - menu.height - 6;
		}
		if (left + menu.width > vw - pad) {
			left = vw - menu.width - pad;
		}
		if (left < pad) left = pad;
		if (top < pad) top = pad;

		setStatusMenuPos({ top, left });
		setStatusMenuVisible(true);
	}, [statusMenuOpen]);

	function toggleStatusMenu(e: React.MouseEvent) {
		e.stopPropagation();
		if (!statusMenuOpen && statusTriggerRef.current) {
			const rect = statusTriggerRef.current.getBoundingClientRect();
			setStatusMenuPos({ top: rect.bottom + 6, left: rect.left });
			setStatusMenuVisible(false);
		}
		setStatusMenuOpen(!statusMenuOpen);
	}

	async function handleStatusMove(task: Task, projectId: string, newStatus: TaskStatus) {
		setMovingStatus(true);
		setStatusMenuOpen(false);
		try {
			const updated = await api.request.moveTask({
				taskId: task.id,
				projectId,
				newStatus,
			});
			dispatch({ type: "updateTask", task: updated });
		} catch (err) {
			alert(t("task.failedMove", { error: String(err) }));
		}
		setMovingStatus(false);
	}

	// App name — always present
	segments.push({
		label: "dev-3.0",
		onClick:
			route.screen !== "dashboard"
				? () => navigate({ screen: "dashboard" })
				: undefined,
	});

	// Project name — when inside a project
	if ("projectId" in route) {
		const project = projects.find((p) => p.id === route.projectId);
		if (project) {
			segments.push({
				label: project.name,
				onClick:
					route.screen !== "project"
						? () =>
								navigate({
									screen: "project",
									projectId: route.projectId,
								})
						: undefined,
			});
		}
	}

	// Last segment — screen-specific
	if (route.screen === "task") {
		const task = tasks.find((t) => t.id === route.taskId);
		segments.push({ label: task?.title || t("header.task") });
	} else if (route.screen === "project-settings") {
		segments.push({ label: t("header.settings") });
	} else if (route.screen === "settings") {
		segments.push({ label: t("header.settings") });
	}

	return (
		<div className="flex items-center justify-between px-5 py-2.5 border-b border-edge flex-shrink-0 glass-header">
			{/* Breadcrumbs */}
			<div className="flex items-center gap-2 text-sm min-w-0 overflow-hidden">
				{segments.map((seg, i) => (
					<Fragment key={i}>
						{i > 0 && (
							<span className="text-fg-muted flex-shrink-0">
								/
							</span>
						)}
						{i === 0 ? (
							seg.onClick ? (
								<button
									onClick={seg.onClick}
									className="flex items-center gap-1.5 text-accent hover:text-accent-hover transition-colors flex-shrink-0"
								>
									<svg className="w-3.5 h-3.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
										<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 9l3 3-3 3m5 0h3" />
										<rect x="3" y="3" width="18" height="18" rx="3" strokeWidth={1.5} />
									</svg>
									<span className="font-mono font-semibold text-xs tracking-wide">{seg.label}</span>
								</button>
							) : (
								<span className="flex items-center gap-1.5 text-accent flex-shrink-0">
									<svg className="w-3.5 h-3.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
										<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 9l3 3-3 3m5 0h3" />
										<rect x="3" y="3" width="18" height="18" rx="3" strokeWidth={1.5} />
									</svg>
									<span className="font-mono font-semibold text-xs tracking-wide">{seg.label}</span>
								</span>
							)
						) : seg.onClick ? (
							<button
								onClick={seg.onClick}
								className="text-fg-3 hover:text-fg transition-colors truncate"
							>
								{seg.label}
							</button>
						) : (
							<span className="text-fg font-semibold truncate">
								{seg.label}
							</span>
						)}
					</Fragment>
				))}
			</div>

			{/* Actions */}
			<div className="flex items-center gap-1.5 flex-shrink-0">
				{/* Status dropdown — only on task screen */}
				{route.screen === "task" && (() => {
					const task = tasks.find((t) => t.id === route.taskId);
					if (!task) return null;
					const color = STATUS_COLORS[task.status];
					return (
						<>
							<button
								ref={statusTriggerRef}
								onClick={toggleStatusMenu}
								disabled={movingStatus}
								className="flex items-center gap-2 px-2.5 py-1 rounded-lg hover:bg-elevated transition-colors"
							>
								<div
									className="w-2 h-2 rounded-full flex-shrink-0"
									style={{ background: color }}
								/>
								<span className="text-[11px] font-medium text-fg-2">
									{t(statusKey(task.status))}
								</span>
								<svg className="w-3 h-3 text-fg-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
									<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
								</svg>
							</button>
							{statusMenuOpen && createPortal(
								<div
									ref={statusMenuRef}
									className="fixed z-50 bg-overlay rounded-xl shadow-2xl shadow-black/40 border border-edge-active py-1.5 min-w-[180px]"
									style={{
										top: statusMenuPos.top,
										left: statusMenuPos.left,
										visibility: statusMenuVisible ? "visible" : "hidden",
									}}
									onClick={(e) => e.stopPropagation()}
								>
									<div className="px-3 py-2 text-xs text-fg-3 uppercase tracking-wider font-semibold">
										{t("task.moveTo")}
									</div>
									{getAllowedTransitions(task.status).map((s) => (
										<button
											key={s}
											onClick={() => handleStatusMove(task, route.projectId, s)}
											className="w-full text-left px-3 py-2 text-sm text-fg-2 hover:bg-elevated-hover hover:text-fg flex items-center gap-2.5 transition-colors"
										>
											<div
												className="w-2.5 h-2.5 rounded-full flex-shrink-0"
												style={{ background: STATUS_COLORS[s] }}
											/>
											{t(statusKey(s))}
										</button>
									))}
								</div>,
								document.body
							)}
						</>
					);
				})()}

				{/* Dev Server — only on task screen */}
				{route.screen === "task" && (() => {
					const project = projects.find((p) => p.id === route.projectId);
					const task = tasks.find((t) => t.id === route.taskId);
					const hasDevScript = !!(project?.devScript?.trim());
					const isTaskActive = !!(task && ACTIVE_STATUSES.includes(task.status));
					const disabled = !hasDevScript || !isTaskActive;
					return (
						<button
							onClick={() => {
								if (!disabled) {
									api.request.runDevServer({ taskId: route.taskId, projectId: route.projectId });
								}
							}}
							disabled={disabled}
							className={`flex items-center gap-1 px-2 py-1 rounded-lg transition-colors ${
								disabled
									? "text-fg-muted cursor-not-allowed"
									: "text-fg-3 hover:text-fg hover:bg-elevated"
							}`}
							title={disabled ? t("header.devServerDisabled") : t("header.devServer")}
						>
							<svg className="w-[18px] h-[18px]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
								<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
									d="M5 12h14M12 5l7 7-7 7" />
							</svg>
							<span className="text-[11px] font-medium">{t("header.devServer")}</span>
						</button>
					);
				})()}

				{/* Project settings — anywhere inside a project (not on project-settings screen itself) */}
				{"projectId" in route && route.screen !== "project-settings" && (
					<button
						onClick={() =>
							navigate({
								screen: "project-settings",
								projectId: route.projectId,
							})
						}
						className="flex items-center gap-1 text-fg-3 hover:text-fg transition-colors px-2 py-1 rounded-lg hover:bg-elevated"
						title={t("header.projectSettings")}
					>
						<svg
							className="w-[18px] h-[18px]"
							fill="none"
							stroke="currentColor"
							viewBox="0 0 24 24"
						>
							{/* Wrench icon — project-specific tooling */}
							<path
								strokeLinecap="round"
								strokeLinejoin="round"
								strokeWidth={1.5}
								d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z"
							/>
						</svg>
						<span className="text-[11px] font-medium">{t("header.projLabel")}</span>
					</button>
				)}

				{/* Global settings */}
				{route.screen !== "settings" && (
					<button
						onClick={() => navigate({ screen: "settings" })}
						className="flex items-center gap-1 text-fg-3 hover:text-fg transition-colors px-2 py-1 rounded-lg hover:bg-elevated"
						title={t("header.globalSettingsTooltip")}
					>
						<svg
							className="w-[18px] h-[18px]"
							fill="none"
							stroke="currentColor"
							viewBox="0 0 24 24"
						>
							{/* Sliders icon — global tuning */}
							<path
								strokeLinecap="round"
								strokeLinejoin="round"
								strokeWidth={1.5}
								d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4"
							/>
						</svg>
						<span className="text-[11px] font-medium">{t("header.globalLabel")}</span>
					</button>
				)}
			</div>
		</div>
	);
}

export default GlobalHeader;
