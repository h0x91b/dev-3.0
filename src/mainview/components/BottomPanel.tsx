import { useState, useRef, useCallback, useEffect } from "react";
import { useT } from "../i18n";
import type { Task, Project } from "../../shared/types";
import { STATUS_COLORS } from "../../shared/types";

interface BottomPanelProps {
	tasks: Task[];
	project: Project | null;
}

type PanelTab = "tasks" | "activity" | "notes";

const MOCK_ACTIVITY = [
	{
		id: 1,
		ago: "2m ago",
		text: "Agent started: Fix login race condition",
		dot: "#9ece6a",
		icon: "▶",
	},
	{
		id: 2,
		ago: "3m ago",
		text: "Worktree ready for task #7",
		dot: "#7aa2f7",
		icon: "◆",
	},
	{
		id: 3,
		ago: "6m ago",
		text: "Status changed: Refactor auth → In Progress",
		dot: "#bb9af7",
		icon: "↗",
	},
	{
		id: 4,
		ago: "10m ago",
		text: "Review requested: Add dark mode support",
		dot: "#e0af68",
		icon: "◈",
	},
	{
		id: 5,
		ago: "25m ago",
		text: "Completed: Update dependencies to latest",
		dot: "#9ece6a",
		icon: "✓",
	},
	{
		id: 6,
		ago: "41m ago",
		text: "Agent started: Write unit tests for parser",
		dot: "#9ece6a",
		icon: "▶",
	},
	{
		id: 7,
		ago: "1h ago",
		text: "Task cancelled: Migrate to Postgres",
		dot: "#f7768e",
		icon: "✕",
	},
];

const DRAG_HANDLE_H = 5;
const TABBAR_H = 32;
const COLLAPSED_H = DRAG_HANDLE_H + TABBAR_H;
const MIN_EXPANDED_H = 100;

function getDefaultExpandedH() {
	return Math.round(window.innerHeight * 0.33);
}

function BottomPanel({ tasks, project }: BottomPanelProps) {
	const t = useT();
	const [expanded, setExpanded] = useState(false);
	const [panelHeight, setPanelHeight] = useState(getDefaultExpandedH);
	const [activeTab, setActiveTab] = useState<PanelTab>("tasks");
	const [isDragging, setIsDragging] = useState(false);

	const dragStartY = useRef(0);
	const dragStartH = useRef(0);

	const handleDragStart = useCallback(
		(e: React.MouseEvent) => {
			e.preventDefault();
			dragStartY.current = e.clientY;
			dragStartH.current = expanded ? panelHeight : COLLAPSED_H;
			setIsDragging(true);
		},
		[expanded, panelHeight],
	);

	useEffect(() => {
		if (!isDragging) return;

		const maxH = Math.round(window.innerHeight * 0.65);

		function onMouseMove(e: MouseEvent) {
			const delta = dragStartY.current - e.clientY;
			const newH = dragStartH.current + delta;

			if (newH < COLLAPSED_H + 10) {
				setExpanded(false);
				return;
			}

			setExpanded(true);
			setPanelHeight(Math.max(MIN_EXPANDED_H, Math.min(maxH, newH)));
		}

		function onMouseUp() {
			setIsDragging(false);
		}

		document.addEventListener("mousemove", onMouseMove);
		document.addEventListener("mouseup", onMouseUp);
		return () => {
			document.removeEventListener("mousemove", onMouseMove);
			document.removeEventListener("mouseup", onMouseUp);
		};
	}, [isDragging]);

	function openTab(tab: PanelTab) {
		setActiveTab(tab);
		if (!expanded) setExpanded(true);
	}

	const currentH = expanded ? panelHeight : COLLAPSED_H;
	const contentH = panelHeight - DRAG_HANDLE_H - TABBAR_H;

	return (
		<div
			className="flex-shrink-0 border-t border-edge flex flex-col glass-header"
			style={{
				height: currentH,
				transition: isDragging ? "none" : "height 0.18s ease",
				userSelect: isDragging ? "none" : undefined,
			}}
		>
			{/* Drag handle */}
			<div
				className="flex-shrink-0 flex items-center justify-center group"
				style={{ height: DRAG_HANDLE_H, cursor: "row-resize" }}
				onMouseDown={handleDragStart}
				onDoubleClick={() => setExpanded((v) => !v)}
			>
				<div
					className={`w-8 rounded-full transition-colors duration-150 ${
						isDragging
							? "bg-accent"
							: "bg-edge-active group-hover:bg-accent/60"
					}`}
					style={{ height: 2 }}
				/>
			</div>

			{/* Tab bar */}
			<div
				className="flex-shrink-0 flex items-center px-2 border-b border-edge gap-0.5"
				style={{ height: TABBAR_H }}
			>
				{(["tasks", "activity", "notes"] as PanelTab[]).map((tab) => {
					const isActive = activeTab === tab && expanded;
					return (
						<button
							key={tab}
							onClick={() => openTab(tab)}
							className={`relative flex items-center gap-1.5 px-2.5 h-6 rounded text-[11px] font-medium transition-colors ${
								isActive
									? "bg-elevated text-fg"
									: "text-fg-3 hover:text-fg-2 hover:bg-elevated/60"
							}`}
						>
							{tab === "tasks" && (
								<svg
									className="w-3 h-3"
									fill="none"
									stroke="currentColor"
									viewBox="0 0 24 24"
								>
									<path
										strokeLinecap="round"
										strokeLinejoin="round"
										strokeWidth={2}
										d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4"
									/>
								</svg>
							)}
							{tab === "activity" && (
								<svg
									className="w-3 h-3"
									fill="none"
									stroke="currentColor"
									viewBox="0 0 24 24"
								>
									<path
										strokeLinecap="round"
										strokeLinejoin="round"
										strokeWidth={2}
										d="M13 10V3L4 14h7v7l9-11h-7z"
									/>
								</svg>
							)}
							{tab === "notes" && (
								<svg
									className="w-3 h-3"
									fill="none"
									stroke="currentColor"
									viewBox="0 0 24 24"
								>
									<path
										strokeLinecap="round"
										strokeLinejoin="round"
										strokeWidth={2}
										d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
									/>
								</svg>
							)}
							{t(`panel.${tab}` as Parameters<typeof t>[0])}
							{tab === "tasks" && tasks.length > 0 && (
								<span className="text-[10px] text-fg-muted tabular-nums">
									{tasks.length}
								</span>
							)}
						</button>
					);
				})}

				<div className="flex-1" />

				{/* Project name chip */}
				{project && (
					<span className="text-[10px] text-fg-muted mr-1 px-1.5 py-0.5 rounded bg-elevated/50 font-mono">
						{project.name}
					</span>
				)}

				{/* Toggle button */}
				<button
					onClick={() => setExpanded((v) => !v)}
					className="p-1 rounded text-fg-muted hover:text-fg-3 hover:bg-elevated/60 transition-colors"
					title={expanded ? t("panel.collapse") : t("panel.expand")}
				>
					<svg
						className={`w-3 h-3 transition-transform duration-150 ${expanded ? "" : "rotate-180"}`}
						fill="none"
						stroke="currentColor"
						viewBox="0 0 24 24"
					>
						<path
							strokeLinecap="round"
							strokeLinejoin="round"
							strokeWidth={2}
							d="M19 9l-7 7-7-7"
						/>
					</svg>
				</button>
			</div>

			{/* Content */}
			{expanded && (
				<div
					className="overflow-y-auto overflow-x-hidden"
					style={{ height: contentH }}
				>
					{activeTab === "tasks" && (
						<TasksTab tasks={tasks} />
					)}
					{activeTab === "activity" && <ActivityTab />}
					{activeTab === "notes" && <NotesTab />}
				</div>
			)}
		</div>
	);
}

/* ── Tasks tab ─────────────────────────────────────────── */

function TasksTab({ tasks }: { tasks: Task[] }) {
	const t = useT();

	if (tasks.length === 0) {
		return (
			<div className="flex items-center justify-center h-full text-fg-muted text-xs">
				{t("panel.noTasks")}
			</div>
		);
	}

	return (
		<div className="py-1.5 px-2 flex flex-col gap-0.5">
			{tasks.map((task) => {
				const color = STATUS_COLORS[task.status];
				return (
					<div
						key={task.id}
						className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-elevated/60 transition-colors group"
					>
						<div
							className="w-1.5 h-1.5 rounded-full flex-shrink-0"
							style={{ background: color }}
						/>
						<span className="text-xs text-fg-2 truncate flex-1 min-w-0">
							{task.title}
						</span>
						<span
							className="text-[10px] flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
							style={{ color }}
						>
							{task.status.replace(/-/g, " ")}
						</span>
					</div>
				);
			})}
		</div>
	);
}

/* ── Activity tab ──────────────────────────────────────── */

function ActivityTab() {
	return (
		<div className="py-1.5 px-2 flex flex-col gap-px">
			{MOCK_ACTIVITY.map((item) => (
				<div
					key={item.id}
					className="flex items-center gap-2.5 px-2 py-1.5 rounded-lg hover:bg-elevated/60 transition-colors"
				>
					<span
						className="text-[10px] font-mono w-4 flex-shrink-0 text-center leading-none"
						style={{ color: item.dot }}
					>
						{item.icon}
					</span>
					<span className="text-xs text-fg-2 flex-1 min-w-0 truncate">
						{item.text}
					</span>
					<span className="text-[10px] text-fg-muted flex-shrink-0 tabular-nums">
						{item.ago}
					</span>
				</div>
			))}
		</div>
	);
}

/* ── Notes tab ─────────────────────────────────────────── */

function NotesTab() {
	const t = useT();
	return (
		<div className="flex flex-col items-center justify-center h-full gap-2 text-fg-muted">
			<svg
				className="w-8 h-8 opacity-30"
				fill="none"
				stroke="currentColor"
				viewBox="0 0 24 24"
			>
				<path
					strokeLinecap="round"
					strokeLinejoin="round"
					strokeWidth={1.5}
					d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
				/>
			</svg>
			<span className="text-xs opacity-50">{t("panel.notesEmpty")}</span>
		</div>
	);
}

export default BottomPanel;
