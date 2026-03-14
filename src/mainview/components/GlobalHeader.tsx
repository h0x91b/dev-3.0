import { Fragment, useState, useEffect, useRef, useCallback } from "react";
import type { Project, Task } from "../../shared/types";
import { getTaskTitle, ACTIVE_STATUSES } from "../../shared/types";
import type { Route } from "../state";
import { useT } from "../i18n";
import { api } from "../rpc";
import TmuxSessionManager from "./TmuxSessionManager";
import InlineRename from "./InlineRename";

interface GlobalHeaderProps {
	route: Route;
	projects: Project[];
	tasks: Task[];
	navigate: (route: Route) => void;
	updateVersion?: string | null;
	updateDownloadStatus?: string | null;
}

interface BreadcrumbSegment {
	label: string;
	badge?: string;
	onClick?: () => void;
	isProjectDropdown?: boolean;
	task?: Task;
}

/** Cache TTL for project task counts (30 seconds) */
const COUNTS_CACHE_TTL = 30_000;

function GlobalHeader({ route, projects, tasks, navigate, updateVersion, updateDownloadStatus }: GlobalHeaderProps) {
	const t = useT();
	const [showUpdateDropdown, setShowUpdateDropdown] = useState(false);
	const [restarting, setRestarting] = useState(false);
	const [showToast, setShowToast] = useState(false);
	const [countdown, setCountdown] = useState(0);
	const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);
	const [showProjectDropdown, setShowProjectDropdown] = useState(false);
	const [projectTaskCounts, setProjectTaskCounts] = useState<Record<string, number>>({});
	const dropdownRef = useRef<HTMLDivElement>(null);
	const projectDropdownRef = useRef<HTMLDivElement>(null);
	const countsCacheTimeRef = useRef<number>(0);

	// Show toast with 60s countdown when updateVersion first appears
	useEffect(() => {
		if (updateVersion) {
			setShowToast(true);
			setCountdown(60);
			countdownRef.current = setInterval(() => {
				setCountdown((prev) => {
					if (prev <= 1) return 0;
					return prev - 1;
				});
			}, 1000);
			return () => {
				if (countdownRef.current) clearInterval(countdownRef.current);
			};
		}
	}, [updateVersion]);

	// Auto-restart when countdown reaches 0
	useEffect(() => {
		if (countdown === 0 && showToast) {
			if (countdownRef.current) clearInterval(countdownRef.current);
			handleRestart();
		}
	}, [countdown, showToast]);

	// Close dropdowns on outside click or Escape
	useEffect(() => {
		if (!showUpdateDropdown && !showProjectDropdown) return;
		function handleClick(e: MouseEvent) {
			if (showUpdateDropdown && dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
				setShowUpdateDropdown(false);
			}
			if (showProjectDropdown && projectDropdownRef.current && !projectDropdownRef.current.contains(e.target as Node)) {
				setShowProjectDropdown(false);
			}
		}
		function handleKeydown(e: KeyboardEvent) {
			if (e.key === "Escape") {
				if (showProjectDropdown) setShowProjectDropdown(false);
				if (showUpdateDropdown) setShowUpdateDropdown(false);
			}
		}
		document.addEventListener("mousedown", handleClick);
		document.addEventListener("keydown", handleKeydown);
		return () => {
			document.removeEventListener("mousedown", handleClick);
			document.removeEventListener("keydown", handleKeydown);
		};
	}, [showUpdateDropdown, showProjectDropdown]);

	// Fetch active task counts when project dropdown opens (with cache)
	useEffect(() => {
		if (!showProjectDropdown) return;
		// Skip fetch if cache is still fresh
		if (Date.now() - countsCacheTimeRef.current < COUNTS_CACHE_TTL) return;
		let cancelled = false;
		async function fetchCounts() {
			const counts: Record<string, number> = {};
			await Promise.all(
				projects.filter((p) => !p.deleted).map(async (p) => {
					try {
						const fetchedTasks = await api.request.getTasks({ projectId: p.id });
						counts[p.id] = fetchedTasks.filter((ft) => ACTIVE_STATUSES.includes(ft.status)).length;
					} catch {
						counts[p.id] = 0;
					}
				}),
			);
			if (!cancelled) {
				setProjectTaskCounts(counts);
				countsCacheTimeRef.current = Date.now();
			}
		}
		fetchCounts();
		return () => { cancelled = true; };
	}, [showProjectDropdown, projects]);

	// Close project dropdown on route change
	useEffect(() => {
		setShowProjectDropdown(false);
	}, [route]);

	function dismissToast() {
		setShowToast(false);
		setCountdown(0);
		if (countdownRef.current) {
			clearInterval(countdownRef.current);
			countdownRef.current = null;
		}
	}

	async function handleRestart() {
		setRestarting(true);
		if (countdownRef.current) {
			clearInterval(countdownRef.current);
			countdownRef.current = null;
		}
		try {
			await api.request.saveUpdateRoute({ route: JSON.stringify(route) });
			await api.request.applyUpdate();
		} catch {
			setRestarting(false);
		}
	}

	const handleProjectNameClick = useCallback(() => {
		if (!("projectId" in route)) return;
		// Navigate to project board (clears activeTaskId / returns from settings/task)
		navigate({ screen: "project", projectId: route.projectId });
	}, [route, navigate]);

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
	// Text click navigates to project board; chevron toggles dropdown
	if ("projectId" in route) {
		const project = projects.find((p) => p.id === route.projectId);
		if (project) {
			const canNavigateToProject =
				route.screen !== "project" || (route.screen === "project" && route.activeTaskId);
			segments.push({
				label: project.name,
				isProjectDropdown: true,
				onClick: canNavigateToProject ? handleProjectNameClick : undefined,
			});
		}
	}

	// Task segment for split view
	if (route.screen === "project" && route.activeTaskId) {
		const task = tasks.find((t) => t.id === route.activeTaskId);
		if (task) {
			const badge = task.variantIndex != null ? `#${task.seq}-${task.variantIndex}` : `#${task.seq}`;
			segments.push({ badge, label: getTaskTitle(task), task });
		}
	}

	// Last segment — screen-specific
	if (route.screen === "task") {
		const task = tasks.find((t) => t.id === route.taskId);
		if (task) {
			const badge = task.variantIndex != null ? `#${task.seq}-${task.variantIndex}` : `#${task.seq}`;
			segments.push({ badge, label: getTaskTitle(task), task });
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

	const currentProjectId = "projectId" in route ? route.projectId : null;
	const availableProjects = projects.filter((p) => !p.deleted);

	return (
		<>
		<div className="relative z-30 flex items-center justify-between px-5 py-2.5 border-b border-edge flex-shrink-0 glass-header">
			{/* Breadcrumbs */}
			<div className="flex items-center gap-2 text-sm min-w-0">
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
						) : seg.isProjectDropdown ? (
							<div className="relative flex items-center gap-0.5" ref={projectDropdownRef}>
								{seg.onClick ? (
									<button
										onClick={seg.onClick}
										className="text-fg-3 hover:text-fg transition-colors truncate"
									>
										{seg.label}
									</button>
								) : (
									<span className="text-fg font-semibold truncate">{seg.label}</span>
								)}
								<button
									onClick={() => setShowProjectDropdown((v) => !v)}
									className="text-fg-muted hover:text-fg transition-colors flex-shrink-0 p-0.5 rounded hover:bg-elevated"
									title={t("header.switchProject")}
									aria-label={t("header.switchProject")}
								>
									<span
										className={`text-[0.75rem] leading-none inline-block transition-transform ${showProjectDropdown ? "rotate-180" : ""}`}
										style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}
									>
										{"\u{F0140}"}
									</span>
								</button>
								{showProjectDropdown && (
									<div className="absolute left-0 top-full mt-1.5 w-72 bg-overlay border border-edge rounded-xl shadow-2xl z-50 py-1 max-h-80 overflow-y-auto">
										{availableProjects.map((p, idx) => {
											const isCurrent = currentProjectId === p.id;
											const count = projectTaskCounts[p.id];
											const shortcutNum = idx < 9 ? idx + 1 : null;
											return (
												<button
													key={p.id}
													onClick={() => {
														setShowProjectDropdown(false);
														navigate({ screen: "project", projectId: p.id });
													}}
													className={`w-full text-left px-3 py-2 flex items-center gap-2 transition-colors ${
														isCurrent
															? "bg-accent/10 text-accent"
															: "text-fg-2 hover:bg-elevated hover:text-fg"
													}`}
												>
													<span className="truncate text-sm flex-1">{p.name}</span>
													<span className="text-[0.6875rem] text-fg-muted flex-shrink-0">
														{count != null
															? count > 0
																? t.plural("header.activeTaskCount", count)
																: t("header.noActiveTasks")
															: ""}
													</span>
													{shortcutNum && (
														<kbd className="flex-shrink-0 inline-flex items-center gap-0.5 text-[0.625rem] text-fg-muted/60 font-mono">
															<span className="text-[0.6875rem]">{"\u2318"}</span>{shortcutNum}
														</kbd>
													)}
												</button>
											);
										})}
									</div>
								)}
							</div>
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
								{seg.task ? (
									<InlineRename
										taskId={seg.task.id}
										projectId={seg.task.projectId}
										currentTitle={seg.label}
										hasCustomTitle={!!seg.task.customTitle}
									/>
								) : (
									<span className="text-fg font-semibold truncate">{seg.label}</span>
								)}
							</span>
						)}
					</Fragment>
				))}
			</div>

			{/* Actions — tmux sessions, changelog, project settings, global settings, external links */}
			<div className="flex items-center gap-1.5 flex-shrink-0">
				{/* Update download progress indicator */}
				{updateDownloadStatus && updateDownloadStatus !== "error" && !updateVersion && (
					<div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-accent/10 text-accent">
						<svg className="w-3.5 h-3.5 animate-spin" viewBox="0 0 24 24" fill="none">
							<circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
							<path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
						</svg>
						<span className="text-[0.6875rem] font-semibold">
							{updateDownloadStatus === "checking" ? t("update.checking") : t("update.downloading")}
						</span>
					</div>
				)}
				{/* Update available indicator */}
				{updateVersion && (
					<div className="relative" ref={dropdownRef}>
						<button
							onClick={() => setShowUpdateDropdown((v) => !v)}
							className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-accent/15 text-accent hover:bg-accent/25 transition-colors animate-pulse"
							title={t("update.readyTooltip", { version: updateVersion })}
						>
							<span
								className="text-[1rem] leading-none"
								style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}
							>
								{"\u{F0A39}"}
							</span>
							<span className="text-[0.6875rem] font-semibold">{t("update.readyLabel")}</span>
						</button>
						{showUpdateDropdown && (
							<div className="absolute right-0 top-full mt-1.5 w-72 bg-overlay border border-edge rounded-xl shadow-2xl z-50 p-4 space-y-3">
								<div className="flex items-center gap-2">
									<span
										className="text-accent text-lg leading-none"
										style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}
									>
										{"\u{F0A39}"}
									</span>
									<div>
										<div className="text-fg text-sm font-semibold">
											{t("update.readyTitle", { version: updateVersion })}
										</div>
										<div className="text-fg-3 text-xs mt-0.5">
											{t("update.sessionsNote")}
										</div>
									</div>
								</div>
								<button
									onClick={handleRestart}
									disabled={restarting}
									className="w-full px-3 py-2 text-sm font-medium rounded-lg bg-accent text-white hover:bg-accent-hover transition-colors disabled:opacity-50"
								>
									{restarting ? t("update.restarting") : t("update.restartBtn")}
								</button>
							</div>
						)}
					</div>
				)}

				{/* Tmux Session Manager */}
				<TmuxSessionManager navigate={navigate} />

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
		{/* Toast notification for update ready */}
		{showToast && updateVersion && (
			<div className="fixed top-14 right-4 z-50 animate-slide-in-right">
				<div className="bg-overlay border border-accent/30 rounded-xl shadow-2xl p-4 w-80 flex items-start gap-3">
					<span
						className="text-accent text-xl leading-none mt-0.5 flex-shrink-0"
						style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}
					>
						{"\u{F0A39}"}
					</span>
					<div className="flex-1 min-w-0">
						<div className="text-fg text-sm font-semibold">
							{t("update.readyTitle", { version: updateVersion })}
						</div>
						<div className="text-fg-3 text-xs mt-1">
							{t("update.sessionsNote")}
						</div>
						<div className="flex items-center gap-2 mt-2.5">
							<button
								onClick={() => { dismissToast(); handleRestart(); }}
								className="px-3 py-1.5 text-xs font-medium rounded-lg bg-accent text-white hover:bg-accent-hover transition-colors"
							>
								{countdown > 0 ? t("update.restartCountdown", { seconds: String(countdown) }) : t("update.restartBtn")}
							</button>
							<button
								onClick={dismissToast}
								className="px-3 py-1.5 text-xs font-medium rounded-lg text-fg-3 hover:text-fg hover:bg-elevated transition-colors"
							>
								{t("update.postponeBtn")}
							</button>
						</div>
					</div>
					<button
						onClick={dismissToast}
						className="text-fg-muted hover:text-fg transition-colors flex-shrink-0"
					>
						<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
							<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
						</svg>
					</button>
				</div>
			</div>
		)}
		</>
	);
}

export default GlobalHeader;
