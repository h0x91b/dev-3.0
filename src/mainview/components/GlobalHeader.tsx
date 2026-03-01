import { Fragment } from "react";
import type { Project, Task } from "../../shared/types";
import type { Route } from "../state";
import { useT } from "../i18n";

interface GlobalHeaderProps {
	route: Route;
	projects: Project[];
	tasks: Task[];
	navigate: (route: Route) => void;
}

interface BreadcrumbSegment {
	label: string;
	onClick?: () => void;
}

function GlobalHeader({ route, projects, tasks, navigate }: GlobalHeaderProps) {
	const t = useT();
	const segments: BreadcrumbSegment[] = [];

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
		const taskLabel = task ? `#${task.seq} ${task.title}` : t("header.task");
		segments.push({ label: taskLabel });
	} else if (route.screen === "project-settings") {
		segments.push({ label: t("header.settings") });
	} else if (route.screen === "settings") {
		segments.push({ label: t("header.settings") });
	} else if (route.screen === "changelog") {
		segments.push({ label: t("header.changelog") });
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

			{/* Actions — changelog, project settings, global settings */}
			<div className="flex items-center gap-1.5 flex-shrink-0">
				{/* Changelog */}
				{route.screen !== "changelog" && (
					<button
						onClick={() => navigate({ screen: "changelog" })}
						className="flex items-center gap-1 text-fg-3 hover:text-fg transition-colors px-2 py-1 rounded-lg hover:bg-elevated"
						title={t("header.changelogTooltip")}
					>
						<svg
							className="w-[18px] h-[18px]"
							fill="none"
							stroke="currentColor"
							viewBox="0 0 24 24"
						>
							{/* Document list icon */}
							<path
								strokeLinecap="round"
								strokeLinejoin="round"
								strokeWidth={1.5}
								d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01"
							/>
						</svg>
						<span className="text-[11px] font-medium">{t("header.changelogLabel")}</span>
					</button>
				)}

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
