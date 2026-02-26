import { useState, useRef, useCallback, useEffect } from "react";
import type { Task, Project } from "../../shared/types";
import { STATUS_COLORS } from "../../shared/types";
import { useT, statusKey } from "../i18n";

interface SubPanelProps {
	task: Task;
	project: Project;
}

const COLLAPSED_HEIGHT = 30;
const DEFAULT_EXPANDED_HEIGHT = 160;
const SNAP_THRESHOLD = 40;
const STORAGE_KEY = "dev3-subpanel-height";

function SubPanel({ task, project }: SubPanelProps) {
	const t = useT();
	const [collapsed, setCollapsed] = useState(true);
	const [height, setHeight] = useState(() => {
		const stored = localStorage.getItem(STORAGE_KEY);
		return stored ? Number(stored) : DEFAULT_EXPANDED_HEIGHT;
	});
	const [isDragging, setIsDragging] = useState(false);
	const dragRef = useRef({ startY: 0, startH: 0 });

	const maxHeight = () => Math.floor(window.innerHeight * 0.4);

	const handleMouseDown = useCallback(
		(e: React.MouseEvent) => {
			e.preventDefault();
			const startH = collapsed ? COLLAPSED_HEIGHT : height;
			dragRef.current = { startY: e.clientY, startH };
			setIsDragging(true);
		},
		[collapsed, height],
	);

	useEffect(() => {
		if (!isDragging) return;

		function onMouseMove(e: MouseEvent) {
			const delta = e.clientY - dragRef.current.startY;
			const newH = Math.max(
				COLLAPSED_HEIGHT,
				Math.min(maxHeight(), dragRef.current.startH + delta),
			);
			if (newH < SNAP_THRESHOLD) {
				setCollapsed(true);
			} else {
				setCollapsed(false);
				setHeight(newH);
			}
		}

		function onMouseUp(e: MouseEvent) {
			setIsDragging(false);
			const delta = e.clientY - dragRef.current.startY;
			const finalH = Math.max(
				COLLAPSED_HEIGHT,
				Math.min(maxHeight(), dragRef.current.startH + delta),
			);
			if (finalH < SNAP_THRESHOLD) {
				setCollapsed(true);
			} else {
				setCollapsed(false);
				setHeight(finalH);
				localStorage.setItem(STORAGE_KEY, String(finalH));
			}
		}

		document.addEventListener("mousemove", onMouseMove);
		document.addEventListener("mouseup", onMouseUp);
		return () => {
			document.removeEventListener("mousemove", onMouseMove);
			document.removeEventListener("mouseup", onMouseUp);
		};
	}, [isDragging]);

	const handleDoubleClick = useCallback(() => {
		setCollapsed((prev) => !prev);
	}, []);

	const currentHeight = collapsed ? COLLAPSED_HEIGHT : height;
	const statusColor = STATUS_COLORS[task.status];
	const branchDisplay = task.branchName || "—";
	const worktreeDisplay = task.worktreePath || "—";
	const createdDate = new Date(task.createdAt).toLocaleDateString();

	return (
		<div
			className="flex-shrink-0 border-b border-edge glass-header relative select-none"
			style={{
				height: currentHeight,
				transition: isDragging ? "none" : "height 0.2s ease",
				overflow: "hidden",
			}}
		>
			{/* Collapsed content */}
			{collapsed && (
				<div className="h-full flex items-center px-4 gap-3">
					{/* Chevron down */}
					<svg
						className="w-3 h-3 text-fg-muted flex-shrink-0"
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
					<span className="text-[11px] text-fg-3 font-medium">
						{t("subPanel.title")}
					</span>
					{/* Branch badge */}
					{task.branchName && (
						<span className="text-[10px] font-mono text-fg-muted bg-elevated px-1.5 py-0.5 rounded">
							{task.branchName}
						</span>
					)}
					{/* Status badge */}
					<span
						className="text-[10px] font-medium px-1.5 py-0.5 rounded"
						style={{
							color: statusColor,
							background: `${statusColor}18`,
						}}
					>
						{t(statusKey(task.status))}
					</span>
				</div>
			)}

			{/* Expanded content */}
			{!collapsed && (
				<div className="h-full flex flex-col px-4 pt-2 pb-1">
					{/* Header row */}
					<div className="flex items-center gap-2 mb-2">
						{/* Chevron up */}
						<svg
							className="w-3 h-3 text-fg-muted flex-shrink-0"
							fill="none"
							stroke="currentColor"
							viewBox="0 0 24 24"
						>
							<path
								strokeLinecap="round"
								strokeLinejoin="round"
								strokeWidth={2}
								d="M5 15l7-7 7 7"
							/>
						</svg>
						<span className="text-[11px] text-fg-3 font-medium">
							{t("subPanel.title")}
						</span>
					</div>

					{/* Three sections in a row */}
					<div className="flex-1 min-h-0 flex gap-6 overflow-hidden">
						{/* Task section */}
						<div className="flex-1 min-w-0">
							<div className="text-[10px] text-fg-muted uppercase tracking-wider font-semibold mb-1.5">
								{t("subPanel.taskSection")}
							</div>
							<div className="space-y-1">
								<InfoRow
									label={t("subPanel.worktree")}
									value={worktreeDisplay}
									mono
								/>
								<InfoRow
									label={t("subPanel.branch")}
									value={branchDisplay}
									mono
								/>
								<InfoRow
									label={t("subPanel.baseBranch")}
									value={task.baseBranch || project.defaultBaseBranch || "main"}
								/>
								<InfoRow
									label={t("subPanel.created")}
									value={createdDate}
								/>
							</div>
						</div>

						{/* Git section */}
						<div className="flex-1 min-w-0">
							<div className="text-[10px] text-fg-muted uppercase tracking-wider font-semibold mb-1.5">
								{t("subPanel.gitSection")}
							</div>
							<div className="space-y-1">
								<InfoRow
									label={t("subPanel.branch")}
									value={branchDisplay}
									mono
									copyable
								/>
								<InfoRow
									label={t("subPanel.lastCommit")}
									value="—"
									mono
								/>
							</div>
						</div>

						{/* Actions section */}
						<div className="flex-1 min-w-0">
							<div className="text-[10px] text-fg-muted uppercase tracking-wider font-semibold mb-1.5">
								{t("subPanel.actionsSection")}
							</div>
							<div className="flex flex-wrap gap-1.5">
								<ActionButton label={t("subPanel.openEditor")} />
								<ActionButton label={t("subPanel.copyBranch")} />
								<ActionButton label={t("subPanel.viewDiff")} />
							</div>
						</div>
					</div>
				</div>
			)}

			{/* Drag handle */}
			<div
				className="absolute bottom-0 left-0 right-0 h-[6px] cursor-row-resize group z-10"
				onMouseDown={handleMouseDown}
				onDoubleClick={handleDoubleClick}
			>
				<div className="absolute bottom-0 left-0 right-0 h-px bg-edge group-hover:bg-accent transition-colors" />
			</div>
		</div>
	);
}

function InfoRow({
	label,
	value,
	mono,
	copyable,
}: {
	label: string;
	value: string;
	mono?: boolean;
	copyable?: boolean;
}) {
	const [copied, setCopied] = useState(false);

	function handleCopy() {
		navigator.clipboard.writeText(value);
		setCopied(true);
		setTimeout(() => setCopied(false), 1500);
	}

	return (
		<div className="flex items-center gap-2 text-[11px] leading-tight">
			<span className="text-fg-muted flex-shrink-0">{label}:</span>
			<span
				className={`text-fg-2 truncate ${mono ? "font-mono" : ""} ${
					copyable ? "cursor-pointer hover:text-accent transition-colors" : ""
				}`}
				onClick={copyable ? handleCopy : undefined}
				title={copyable ? value : undefined}
			>
				{copied ? "Copied!" : value}
			</span>
		</div>
	);
}

function ActionButton({ label }: { label: string }) {
	return (
		<button className="text-[10px] text-fg-3 hover:text-fg px-2 py-1 rounded bg-elevated hover:bg-elevated-hover transition-colors">
			{label}
		</button>
	);
}

export default SubPanel;
