import type { MouseEvent } from "react";
import type { Project } from "../../shared/types";
import { isBuiltinOpsProject } from "../../shared/types";
import type { Route } from "../state";
import { api } from "../rpc";
import { useT } from "../i18n";

interface ProjectActionButtonsProps {
	project: Project;
	navigate: (route: Route) => void;
	onRemove?: (projectId: string) => void | Promise<void>;
	className?: string;
}

function ProjectActionButtons({
	project,
	navigate,
	onRemove,
	className = "",
}: ProjectActionButtonsProps) {
	const t = useT();
	// Virtual ("Operations") boards have no real project folder: their synthetic
	// path (~/.dev3.0/ops/<slug>) is created lazily per-task, so "Open in Finder"
	// no-ops and "Project Terminal" throws "Project path does not exist". Hide both.
	const isVirtual = project.kind === "virtual";
	// The built-in Operations board is a pinned system object — it must not be
	// deletable (removing it dead-ends ⌘0 until restart, then orphans its tasks).
	const isBuiltin = isBuiltinOpsProject(project);

	function stopEvent(event: MouseEvent<HTMLButtonElement>) {
		event.stopPropagation();
	}

	// Hover raises emphasis, it never *creates* the control: the cluster rests at
	// `text-fg-3` — same tone as the reorder buttons at the other end of the row,
	// and the quietest step that still clears 3:1 on the light theme's surface.
	const iconButton =
		"text-fg-3 transition-colors p-2 rounded-lg focus-visible:outline-none focus-visible:text-fg focus-visible:ring-2 focus-visible:ring-accent";
	const neutralButton = `${iconButton} hover:text-fg hover:bg-elevated`;

	return (
		<div className={`flex items-center gap-0.5 ${className}`.trim()}>
			<button
				type="button"
				onClick={(event) => {
					stopEvent(event);
					navigate({ screen: "project-settings", projectId: project.id });
				}}
				className={neutralButton}
				title={t("header.projectSettings")}
				aria-label={t("header.projectSettings")}
			>
				<span
					aria-hidden="true"
					className="text-base leading-none"
					style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}
				>
					{"\u{F0493}"}
				</span>
			</button>
			{!isVirtual && (
				<button
					type="button"
					onClick={(event) => {
						stopEvent(event);
						api.request.openFolder({ path: project.path }).catch(() => {});
					}}
					className={neutralButton}
					title={t("dashboard.openInFinder")}
					aria-label={t("dashboard.openInFinder")}
				>
					<span
						aria-hidden="true"
						className="text-base leading-none"
						style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}
					>
						{"\u{F115}"}
					</span>
				</button>
			)}
			{!isVirtual && (
				<button
					type="button"
					onClick={(event) => {
						stopEvent(event);
						navigate({ screen: "project-terminal", projectId: project.id });
					}}
					className={neutralButton}
					title={t("projectTerminal.tooltip")}
					aria-label={t("projectTerminal.tooltip")}
				>
					<span
						aria-hidden="true"
						className="text-base leading-none"
						style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}
					>
						{"\uF489"}
					</span>
				</button>
			)}
			{onRemove && !isBuiltin && (
				<button
					type="button"
					onClick={(event) => {
						stopEvent(event);
						void onRemove(project.id);
					}}
					className={`${iconButton} ml-2 hover:text-danger hover:bg-danger/10`}
					title={t("dashboard.remove")}
					aria-label={t("dashboard.remove")}
				>
					<span
						aria-hidden="true"
						className="text-base leading-none"
						style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}
					>
						{"\u{F0A79}"}
					</span>
				</button>
			)}
		</div>
	);
}

export default ProjectActionButtons;
