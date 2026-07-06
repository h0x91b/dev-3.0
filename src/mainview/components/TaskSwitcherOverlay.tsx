import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { Project, Task } from "../../shared/types";
import { getTaskTitle } from "../../shared/types";
import { useStatusColors } from "../hooks/useStatusColors";
import type { SwitcherSession } from "../hooks/useTaskSwitcher";
import { api } from "../rpc";
import { ansiToHtml } from "../utils/ansi-to-html";
import { useT } from "../i18n";

interface TaskSwitcherOverlayProps {
	session: SwitcherSession;
	projectById: Map<string, Project>;
	onHover: (index: number) => void;
	onCommit: (index: number) => void;
	onCancel: () => void;
}

function effectiveOverview(task: Task): string {
	const user = task.userOverview?.trim();
	if (user) return user;
	return task.overview?.trim() || "";
}

/** Tiny live terminal snapshot (ANSI → HTML), same render path as the hover preview. */
function TerminalThumbnail({ taskId }: { taskId: string }) {
	const [html, setHtml] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		(async () => {
			try {
				const content = await api.request.getTerminalPreview({ taskId });
				if (!cancelled) setHtml(content ? ansiToHtml(content) : null);
			} catch {
				if (!cancelled) setHtml(null);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [taskId]);

	return (
		<div className="w-36 h-20 flex-shrink-0 overflow-hidden rounded border border-edge bg-base">
			{html ? (
				<pre
					className="m-0 p-1 overflow-hidden"
					style={{
						fontFamily: "monospace",
						fontSize: "3.5px",
						lineHeight: "4.5px",
						color: "#d3d7cf",
						whiteSpace: "pre",
						userSelect: "none",
					}}
					dangerouslySetInnerHTML={{ __html: html }}
				/>
			) : null}
		</div>
	);
}

function TaskSwitcherOverlay({
	session,
	projectById,
	onHover,
	onCommit,
	onCancel,
}: TaskSwitcherOverlayProps) {
	const t = useT();
	const statusColors = useStatusColors();
	const { scope, items, index } = session;

	return createPortal(
		<div
			className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50"
			onMouseDown={(e) => {
				if (e.target === e.currentTarget) onCancel();
			}}
			data-testid="task-switcher-overlay"
		>
			<div
				className="bg-overlay border border-edge rounded-2xl shadow-2xl w-[46rem] max-w-[92vw] max-h-[74vh] flex flex-col overflow-hidden"
				role="dialog"
				aria-label={t("taskSwitcher.title")}
			>
				<div className="flex items-center justify-between px-4 py-2.5 border-b border-edge">
					<span className="text-fg text-sm font-semibold">{t("taskSwitcher.title")}</span>
					<span
						className={`text-xs font-medium px-2 py-0.5 rounded-full border ${
							scope === "global"
								? "text-accent border-accent/40 bg-accent/15"
								: "text-fg-3 border-edge"
						}`}
					>
						{scope === "global" ? t("taskSwitcher.scopeGlobal") : t("taskSwitcher.scopeProject")}
					</span>
				</div>

				<div className="flex-1 min-h-0 overflow-y-auto p-2 flex flex-col gap-1" role="listbox">
					{items.map((task, i) => {
						const selected = i === index;
						const overview = effectiveOverview(task);
						const project = projectById.get(task.projectId);
						return (
							<button
								key={task.id}
								type="button"
								role="option"
								aria-selected={selected}
								ref={(el) => {
									if (el && selected) el.scrollIntoView({ block: "nearest" });
								}}
								onMouseEnter={() => onHover(i)}
								onClick={() => onCommit(i)}
								className={`flex items-start gap-3 w-full text-left px-2.5 py-2.5 rounded-lg transition-colors ${
									selected ? "bg-accent/15" : "hover:bg-elevated-hover"
								}`}
							>
								<TerminalThumbnail taskId={task.id} />
								<div className="flex-1 min-w-0">
									<div className="flex items-center gap-2 min-w-0">
										<span
											className="w-2 h-2 rounded-full flex-shrink-0"
											style={{ background: statusColors[task.status] }}
										/>
										<span className="text-fg text-sm font-medium truncate">
											{getTaskTitle(task)}
										</span>
										{scope === "global" && project && (
											<span className="text-fg-3 text-xs flex-shrink-0">{project.name}</span>
										)}
									</div>
									<p
										className={`text-[13px] leading-snug mt-1 line-clamp-2 ${
											overview ? "text-fg-3" : "text-fg-muted italic"
										}`}
									>
										{overview || t("taskSwitcher.noOverview")}
									</p>
								</div>
							</button>
						);
					})}
				</div>

				<div className="flex items-center justify-between gap-3 px-4 py-2 border-t border-edge">
					<span
						className={`flex items-center gap-1.5 text-xs ${
							scope === "global" ? "text-accent" : "text-fg-muted"
						}`}
						data-testid="task-switcher-scope-toggle"
					>
						<kbd
							className={`px-1.5 py-0.5 rounded border text-[11px] font-semibold leading-none ${
								scope === "global"
									? "border-accent/40 bg-accent/15 text-accent"
									: "border-edge bg-elevated text-fg-2"
							}`}
						>
							⇧
						</kbd>
						{t("taskSwitcher.toggleScope")}
					</span>
					<span className="text-fg-muted text-xs">{t("taskSwitcher.hint")}</span>
				</div>
			</div>
		</div>,
		document.body,
	);
}

export default TaskSwitcherOverlay;
