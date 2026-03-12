import { useState, useRef, useEffect, type Dispatch } from "react";
import type { PortInfo, Project, Task, TaskStatus } from "../../shared/types";
import { ACTIVE_STATUSES, getTaskTitle } from "../../shared/types";
import { useStatusColors } from "../hooks/useStatusColors";
import { useTerminalPreview } from "../hooks/useTerminalPreview";
import type { AppAction, Route } from "../state";
import { useT, statusKey } from "../i18n";
import { matchesSearchQuery } from "../utils/taskSearch";
import LabelChip from "./LabelChip";
import TerminalPreviewPopover from "./TerminalPreviewPopover";

interface ActiveTasksSidebarProps {
	project: Project;
	tasks: Task[];
	activeTaskId?: string;
	dispatch: Dispatch<AppAction>;
	navigate: (route: Route) => void;
	bellCounts: Map<string, number>;
	taskPorts: Map<string, PortInfo[]>;
	onSwitchToBoard: () => void;
}

/** Status display order: most actionable for the user first */
const STATUS_ORDER: TaskStatus[] = [
	"review-by-user",
	"review-by-colleague",
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
	taskPorts,
	onSwitchToBoard,
}: ActiveTasksSidebarProps) {
	const t = useT();
	const statusColors = useStatusColors();
	const preview = useTerminalPreview();
	const [searchQuery, setSearchQuery] = useState("");
	const searchRef = useRef<HTMLInputElement>(null);

	// Ctrl/Cmd+F focuses the search input when sidebar is visible
	useEffect(() => {
		function handleKeyDown(e: KeyboardEvent) {
			if ((e.metaKey || e.ctrlKey) && e.key === "f") {
				e.preventDefault();
				searchRef.current?.focus();
			}
		}
		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, []);

	let activeTasks = tasks.filter((task) => ACTIVE_STATUSES.includes(task.status));
	if (searchQuery.trim()) {
		activeTasks = activeTasks.filter((task) => matchesSearchQuery(task, searchQuery));
	}

	// Group by status in display order
	const grouped = STATUS_ORDER
		.map((status) => ({
			status,
			tasks: activeTasks.filter((task) => task.status === status),
		}))
		.filter((g) => g.tasks.length > 0);

	function handleTaskClick(task: Task) {
		preview.close();
		if (task.id === activeTaskId) {
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

			{/* Search input */}
			<div className="px-2 py-1.5 border-b border-edge flex-shrink-0">
				<div className="relative">
					<svg
						className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-fg-3 pointer-events-none"
						fill="none"
						viewBox="0 0 24 24"
						strokeWidth={2}
						stroke="currentColor"
					>
						<path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
					</svg>
					<input
						ref={searchRef}
						type="text"
						value={searchQuery}
						onChange={(e) => setSearchQuery(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Escape") {
								e.stopPropagation();
								setSearchQuery("");
								searchRef.current?.blur();
							}
						}}
						placeholder={t("sidebar.searchPlaceholder")}
						className="w-full pl-6 pr-5 py-1 text-xs bg-base border border-edge rounded-md text-fg placeholder:text-fg-muted focus:outline-none focus:border-edge-active transition-colors"
					/>
					{searchQuery && (
						<button
							type="button"
							onClick={() => setSearchQuery("")}
							className="absolute right-1.5 top-1/2 -translate-y-1/2 text-fg-3 hover:text-fg text-xs leading-none"
						>
							×
						</button>
					)}
				</div>
			</div>

			{/* Task list */}
			<div className="flex-1 overflow-y-auto overflow-x-hidden">
				{grouped.length === 0 ? (
					<div className="px-3 py-6 text-center text-xs text-fg-muted">
						{searchQuery.trim() ? t("sidebar.noSearchResults") : t("sidebar.noActiveTasks")}
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
											onClick={() => handleTaskClick(task)}
											onMouseEnter={(e) => preview.handlers.onMouseEnter(task.id, e.currentTarget)}
											onMouseLeave={preview.handlers.onMouseLeave}
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

											{/* Port indicators */}
											{(() => {
												const ports = taskPorts.get(task.id);
												if (!ports || ports.length === 0) return null;
												return (
													<div className="flex flex-wrap gap-1 mt-1">
														{ports.map((p) => (
															<span
																key={p.port}
																className="inline-flex items-center gap-1 text-[0.5625rem] font-mono text-accent bg-accent/10 px-1.5 py-0.5 rounded"
																title={`${p.processName} (PID ${p.pid})`}
																onClick={(e) => {
																	e.stopPropagation();
																	window.open(`http://localhost:${p.port}`, "_blank");
																}}
															>
																<span style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>{"\uF0AC"}</span>
																:{p.port}
															</span>
														))}
													</div>
												);
											})()}
										</button>
									</div>
								);
							})}
						</div>
					))
				)}
			</div>

			<TerminalPreviewPopover {...preview.state} />
		</div>
	);
}

export default ActiveTasksSidebar;
