import type { MouseEvent } from "react";
import type { Project } from "../../shared/types";
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

	function stopEvent(event: MouseEvent<HTMLButtonElement>) {
		event.stopPropagation();
	}

	return (
		<div className={`flex items-center gap-0.5 transition-all ${className}`.trim()}>
			<button
				type="button"
				onClick={(event) => {
					stopEvent(event);
					navigate({ screen: "project-settings", projectId: project.id });
				}}
				className="text-fg-3 hover:text-fg transition-colors p-1.5 rounded-lg hover:bg-elevated"
				title={t("header.projectSettings")}
				aria-label={t("header.projectSettings")}
			>
				<span
					className="text-[1rem] leading-none"
					style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}
				>
					{"\u{F0493}"}
				</span>
			</button>
			<button
				type="button"
				onClick={(event) => {
					stopEvent(event);
					api.request.openFolder({ path: project.path }).catch(() => {});
				}}
				className="text-fg-3 hover:text-fg transition-colors p-1.5 rounded-lg hover:bg-elevated"
				title={t("dashboard.openInFinder")}
				aria-label={t("dashboard.openInFinder")}
			>
				<span
					className="text-[1rem] leading-none"
					style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}
				>
					{"\u{F115}"}
				</span>
			</button>
			<button
				type="button"
				onClick={(event) => {
					stopEvent(event);
					navigate({ screen: "project-terminal", projectId: project.id });
				}}
				className="text-fg-3 hover:text-fg transition-colors p-1.5 rounded-lg hover:bg-elevated"
				title={t("projectTerminal.tooltip")}
				aria-label={t("projectTerminal.tooltip")}
			>
				<span
					className="text-[1rem] leading-none"
					style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}
				>
					{"\uF489"}
				</span>
			</button>
			{onRemove && (
				<button
					type="button"
					onClick={(event) => {
						stopEvent(event);
						void onRemove(project.id);
					}}
					className="text-fg-3 hover:text-danger transition-colors p-1.5 rounded-lg hover:bg-danger/10"
					title={t("dashboard.remove")}
					aria-label={t("dashboard.remove")}
				>
					<span
						className="text-[1rem] leading-none"
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
