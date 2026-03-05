import { Fragment } from "react";
import type { Project, Task } from "../../shared/types";
import type { Route } from "../state";
import { useT } from "../i18n";
import TmuxSessionManager from "./TmuxSessionManager";

interface GlobalHeaderProps {
	route: Route;
	projects: Project[];
	tasks: Task[];
	navigate: (route: Route) => void;
}

interface BreadcrumbSegment {
	label: string;
	badge?: string;
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
					route.screen !== "project" || (route.screen === "project" && route.activeTaskId)
						? () =>
								navigate({
									screen: "project",
									projectId: route.projectId,
								})
						: undefined,
			});
		}
	}

	// Task segment for split view
	if (route.screen === "project" && route.activeTaskId) {
		const task = tasks.find((t) => t.id === route.activeTaskId);
		if (task) {
			const badge = task.variantIndex != null ? `#${task.seq}-${task.variantIndex}` : `#${task.seq}`;
			segments.push({ badge, label: task.title });
		}
	}

	// Last segment — screen-specific
	if (route.screen === "task") {
		const task = tasks.find((t) => t.id === route.taskId);
		if (task) {
			const badge = task.variantIndex != null ? `#${task.seq}-${task.variantIndex}` : `#${task.seq}`;
			segments.push({ badge, label: task.title });
		} else {
			segments.push({ label: t("header.task") });
		}
	} else if (route.screen === "project-settings") {
		segments.push({ label: t("header.settings") });
	} else if (route.screen === "settings") {
		segments.push({ label: t("header.settings") });
	} else if (route.screen === "changelog") {
		segments.push({ label: t("header.changelog") });
	} else if (route.screen === "gauge-demo") {
		segments.push({ label: t("gaugeDemo.title") });
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
							<span className="flex items-baseline gap-1.5 min-w-0 overflow-hidden">
								{seg.badge && (
									<span className="font-mono text-[0.6875rem] text-accent/70 flex-shrink-0 tracking-wide">{seg.badge}</span>
								)}
								<span className="text-fg font-semibold truncate">{seg.label}</span>
							</span>
						)}
					</Fragment>
				))}
			</div>

			{/* Actions — tmux sessions, changelog, project settings, global settings, external links */}
			<div className="flex items-center gap-1.5 flex-shrink-0">
				{/* Tmux Session Manager */}
				<TmuxSessionManager />

				{/* GitHub website */}
				<button
					onClick={() => window.open("https://h0x91b.github.io/dev-3.0/", "_blank")}
					className="flex items-center gap-1 text-fg-3 hover:text-fg transition-colors px-2 py-1 rounded-lg hover:bg-elevated"
					title={t("header.githubTooltip")}
				>
					<svg
						className="w-[1.125rem] h-[1.125rem]"
						fill="currentColor"
						viewBox="0 0 24 24"
					>
						<path d="M12 0C5.374 0 0 5.373 0 12c0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.509 11.509 0 0112 5.803c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576C20.566 21.797 24 17.3 24 12c0-6.627-5.373-12-12-12z" />
					</svg>
				</button>

				{/* Report a bug */}
				<button
					onClick={() => window.open("https://github.com/h0x91b/dev-3.0/issues", "_blank")}
					className="flex items-center gap-1 text-fg-3 hover:text-fg transition-colors px-2 py-1 rounded-lg hover:bg-elevated"
					title={t("header.reportBugTooltip")}
				>
					<span className="text-[1.125rem] leading-none" style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>{"\uf188"}</span>
					<span className="text-[0.6875rem] font-medium">{t("header.reportLabel")}</span>
				</button>

				{/* Changelog */}
				{route.screen !== "changelog" && (
					<button
						onClick={() => navigate({ screen: "changelog" })}
						className="flex items-center gap-1 text-fg-3 hover:text-fg transition-colors px-2 py-1 rounded-lg hover:bg-elevated"
						title={t("header.changelogTooltip")}
					>
						<svg
							className="w-[1.125rem] h-[1.125rem]"
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
						<span className="text-[0.6875rem] font-medium">{t("header.changelogLabel")}</span>
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
							className="w-[1.125rem] h-[1.125rem]"
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
						<span className="text-[0.6875rem] font-medium">{t("header.projLabel")}</span>
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
							className="w-[1.125rem] h-[1.125rem]"
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
						<span className="text-[0.6875rem] font-medium">{t("header.globalLabel")}</span>
					</button>
				)}
			</div>
		</div>
	);
}

export default GlobalHeader;
