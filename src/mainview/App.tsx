import { useState, useEffect, useCallback, useRef } from "react";
import { useAppState, type Route } from "./state";
import { api } from "./rpc";
import { useT } from "./i18n";
import { trackPageView, trackEvent } from "./analytics";
import type { RequirementCheckResult } from "../shared/types";
import { useGlobalShortcut } from "./hooks/useGlobalShortcut";
import { adjustZoom, applyZoom, ZOOM_STEP, DEFAULT_ZOOM } from "./zoom";
import { useViewport } from "./hooks/useViewport";
import GlobalHeader from "./components/GlobalHeader";
import GlobalSettings from "./components/GlobalSettings";
import Dashboard from "./components/Dashboard";
import ProjectView from "./components/ProjectView";
import TaskTerminal from "./components/TaskTerminal";
import ProjectTerminal from "./components/ProjectTerminal";
import ProjectSettings from "./components/ProjectSettings";
import RequirementsCheck from "./components/RequirementsCheck";
import GhWarningBanner, { isGhWarningDismissed } from "./components/GhWarningBanner";
import Changelog from "./components/Changelog";
import GaugeDemo from "./components/gauges/GaugeDemo";
import ViewportLab from "./components/ViewportLab";

const SKIP_QUIT_DIALOG_KEY = "dev3-skip-quit-dialog";

function App() {
	const [state, dispatch] = useAppState();
	const t = useT();
	useViewport(state.route);

	// Quit dialog
	const [showQuitDialog, setShowQuitDialog] = useState(false);
	const [dontShowAgain, setDontShowAgain] = useState(false);

	// Silent update indicator
	const [updateVersion, setUpdateVersion] = useState<string | null>(null);
	// Download progress: null = idle, "checking" | "downloading" | "error"
	const [updateDownloadStatus, setUpdateDownloadStatus] = useState<string | null>(null);
	const updateStatusShownAtRef = useRef<number>(0);
	const updateClearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	// Remote access QR code modal
	const [remoteQR, setRemoteQR] = useState<{ qrDataUrl: string; accessUrl: string; tunnelState: string; cloudflaredInstalled: boolean } | null>(null);
	const [tunnelWanted, setTunnelWanted] = useState(false);
	const [tunnelStarting, setTunnelStarting] = useState(false);

	// System requirements gate
	const [reqStatus, setReqStatus] = useState<"checking" | "failed" | "passed">("checking");
	const [reqResults, setReqResults] = useState<RequirementCheckResult[]>([]);
	const [reqChecking, setReqChecking] = useState(false);

	// GitHub CLI availability warning
	const [ghWarning, setGhWarning] = useState<{ notInstalled: boolean } | null>(null);

	const checkRequirements = useCallback(async () => {
		setReqChecking(true);
		try {
			const results = await api.request.checkSystemRequirements();
			setReqResults(results);
			const allOk = results.every((r) => r.installed || r.optional);
			setReqStatus(allOk ? "passed" : "failed");
		} catch (err) {
			console.error("Failed to check system requirements:", err);
			// If we can't check, assume OK to avoid blocking the app
			setReqStatus("passed");
		}
		setReqChecking(false);
	}, []);

	// Refresh results without dismissing the screen (used after Set path)
	const refreshResults = useCallback(async () => {
		try {
			const results = await api.request.checkSystemRequirements();
			setReqResults(results);
		} catch (err) {
			console.error("Failed to refresh requirements:", err);
		}
	}, []);

	useEffect(() => {
		checkRequirements();
	}, [checkRequirements]);

	// Navigation guard for unsaved-changes prompts (e.g. ProjectSettings)
	const navigationGuardRef = useRef<{
		isDirty: () => boolean;
		onSave: () => Promise<void>;
	} | null>(null);
	const [pendingNavigation, setPendingNavigation] = useState<Route | null>(null);

	const navigate = useCallback(
		(route: Route) => {
			if (navigationGuardRef.current?.isDirty()) {
				setPendingNavigation(route);
				return;
			}
			dispatch({ type: "navigate", route });
		},
		[dispatch],
	);

	// Cmd/Ctrl+Q, Cmd/Ctrl+,, Cmd/Ctrl+=/- (zoom) — capture phase so terminal can't swallow them
	useGlobalShortcut(
		(e) => {
			if ((e.metaKey || e.ctrlKey) && e.key === "q") {
				e.preventDefault();
				e.stopPropagation();
				if (localStorage.getItem(SKIP_QUIT_DIALOG_KEY) === "true") {
					api.request.quitApp().catch(() => {});
				} else {
					setShowQuitDialog(true);
				}
			} else if ((e.metaKey || e.ctrlKey) && e.key === "h") {
				e.preventDefault();
				e.stopPropagation();
				api.request.hideApp().catch(() => {});
			} else if ((e.metaKey || e.ctrlKey) && e.key === ",") {
				e.preventDefault();
				e.stopPropagation();
				navigate({ screen: "settings" });
			} else if ((e.metaKey || e.ctrlKey) && (e.key === "=" || e.key === "+")) {
				e.preventDefault();
				e.stopPropagation();
				adjustZoom(ZOOM_STEP);
			} else if ((e.metaKey || e.ctrlKey) && e.key === "-") {
				e.preventDefault();
				e.stopPropagation();
				adjustZoom(-ZOOM_STEP);
			} else if ((e.metaKey || e.ctrlKey) && e.key === "0") {
				e.preventDefault();
				e.stopPropagation();
				applyZoom(DEFAULT_ZOOM);
			} else if ((e.metaKey || e.ctrlKey) && e.key === "`") {
				// Cmd+` — toggle project terminal
				const { route } = state;
				if (route.screen === "project-terminal") {
					e.preventDefault();
					e.stopPropagation();
					navigate({ screen: "project", projectId: route.projectId });
				} else if ("projectId" in route) {
					e.preventDefault();
					e.stopPropagation();
					navigate({ screen: "project-terminal", projectId: route.projectId });
				}
			} else if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key >= "1" && e.key <= "9") {
				// Cmd+1..9 — switch to project by index (like Slack workspaces)
				const idx = parseInt(e.key, 10) - 1;
				const available = state.projects.filter((p) => !p.deleted);
				if (idx < available.length) {
					e.preventDefault();
					e.stopPropagation();
					navigate({ screen: "project", projectId: available[idx].id });
				}
			}
		},
		[navigate, state.projects, state.route],
		{ capture: true },
	);

	function handleConfirmQuit() {
		if (dontShowAgain) {
			localStorage.setItem(SKIP_QUIT_DIALOG_KEY, "true");
		}
		api.request.quitApp().catch(() => {});
	}

	// Check gh availability after requirements pass (non-blocking)
	useEffect(() => {
		if (reqStatus !== "passed") return;
		if (isGhWarningDismissed()) return;
		api.request.checkGhAvailable()
			.then(({ available, notInstalled }) => {
				if (!available) {
					setGhWarning({ notInstalled });
				}
			})
			.catch(() => {
				// Ignore — don't block the app if this check fails
			});
	}, [reqStatus]);

	// Load projects on mount — gated on requirements passing
	useEffect(() => {
		if (reqStatus !== "passed") return;
		(async () => {
			try {
				const projects = await api.request.getProjects();
				dispatch({ type: "setProjects", projects });

				// Restore route saved before an update restart
				try {
					const { route: savedRoute } = await api.request.getUpdateRoute();
					if (savedRoute) {
						const route = JSON.parse(savedRoute) as Route;
						dispatch({ type: "navigate", route });
					}
				} catch {
					// Ignore — file may not exist or be malformed
				}
			} catch (err) {
				console.error("Failed to load projects:", err);
			}
			dispatch({ type: "setLoading", loading: false });
		})();
	}, [dispatch, reqStatus]);

	// Refresh projects from disk whenever user navigates to dashboard
	useEffect(() => {
		if (state.route.screen !== "dashboard" || state.loading) return;
		(async () => {
			try {
				const projects = await api.request.getProjects();
				dispatch({ type: "setProjects", projects });
			} catch (err) {
				console.error("Failed to refresh projects:", err);
			}
		})();
	}, [dispatch, state.route.screen, state.loading]);

	// Listen for push messages from bun
	useEffect(() => {
		function onTaskUpdated(e: Event) {
			const { task } = (e as CustomEvent).detail;
			dispatch({ type: "updateTask", task });
		}
		window.addEventListener("rpc:taskUpdated", onTaskUpdated);
		return () => window.removeEventListener("rpc:taskUpdated", onTaskUpdated);
	}, [dispatch]);

	useEffect(() => {
		function onProjectUpdated(e: Event) {
			const { project } = (e as CustomEvent).detail;
			dispatch({ type: "updateProject", project });
		}
		window.addEventListener("rpc:projectUpdated", onProjectUpdated);
		return () => window.removeEventListener("rpc:projectUpdated", onProjectUpdated);
	}, [dispatch]);

	useEffect(() => {
		function onTerminalBell(e: Event) {
			const { taskId } = (e as CustomEvent).detail;
			dispatch({ type: "addBell", taskId });
		}
		window.addEventListener("rpc:terminalBell", onTerminalBell);
		return () => window.removeEventListener("rpc:terminalBell", onTerminalBell);
	}, [dispatch]);

	// Listen for port scan updates
	useEffect(() => {
		function onPortsUpdated(e: Event) {
			const { taskId, ports } = (e as CustomEvent).detail;
			dispatch({ type: "setPorts", taskId, ports });
		}
		window.addEventListener("rpc:portsUpdated", onPortsUpdated);
		return () => window.removeEventListener("rpc:portsUpdated", onPortsUpdated);
	}, [dispatch]);

	// Listen for resource usage updates
	useEffect(() => {
		function onResourceUsageUpdated(e: Event) {
			const { taskId, usage } = (e as CustomEvent).detail;
			dispatch({ type: "setResourceUsage", taskId, usage });
		}
		window.addEventListener("rpc:resourceUsageUpdated", onResourceUsageUpdated);
		return () => window.removeEventListener("rpc:resourceUsageUpdated", onResourceUsageUpdated);
	}, [dispatch]);

	// Listen for branch merge detection — offer to complete the task
	useEffect(() => {
		async function onBranchMerged(e: Event) {
			const { taskId, projectId, taskTitle, branchName } = (e as CustomEvent).detail as {
				taskId: string;
				projectId: string;
				taskTitle: string;
				branchName: string;
			};
			let shouldComplete = false;
			try {
				shouldComplete = await api.request.showConfirm({
					title: t("app.branchMergedTitle"),
					message: t("app.branchMergedMessage", { taskTitle, branchName }),
				});
			} catch (err) {
				console.error("[App] showConfirm (branch-merged) failed:", err);
			}
			if (shouldComplete) {
				dispatch({
					type: "updateTask",
					task: {
						id: taskId,
						projectId,
						status: "completed",
						worktreePath: null,
						branchName: null,
						movedAt: new Date().toISOString(),
						columnOrder: undefined,
					} as any,
				});
				dispatch({ type: "clearBell", taskId });
				trackEvent("task_moved", { from_status: "review-by-user", to_status: "completed" });
				api.request.moveTask({
					taskId,
					projectId,
					newStatus: "completed",
				}).catch(() => {
					api.request.moveTask({
						taskId,
						projectId,
						newStatus: "completed",
						force: true,
					}).catch((err) => console.error("moveTask (branch-merged) failed:", err));
				});
			}
		}
		window.addEventListener("rpc:branchMerged", onBranchMerged);
		return () => window.removeEventListener("rpc:branchMerged", onBranchMerged);
	}, [dispatch, t]);

	// Listen for silent update ready notification
	useEffect(() => {
		function onUpdateAvailable(e: Event) {
			const { version } = (e as CustomEvent).detail;
			setUpdateVersion(version);
			setUpdateDownloadStatus(null); // clear download indicator once ready
		}
		window.addEventListener("rpc:updateAvailable", onUpdateAvailable);
		return () => window.removeEventListener("rpc:updateAvailable", onUpdateAvailable);
	}, []);

	// Listen for update download progress (minimum 5s display time)
	useEffect(() => {
		const MIN_DISPLAY_MS = 5_000;
		function onDownloadProgress(e: Event) {
			const { status } = (e as CustomEvent).detail;
			if (status === "complete" || status === "idle") {
				// Clear after minimum display time
				const elapsed = Date.now() - updateStatusShownAtRef.current;
				const remaining = Math.max(0, MIN_DISPLAY_MS - elapsed);
				if (updateClearTimerRef.current) clearTimeout(updateClearTimerRef.current);
				updateClearTimerRef.current = setTimeout(() => {
					setUpdateDownloadStatus(null);
					updateClearTimerRef.current = null;
				}, remaining);
			} else {
				// Show immediately, record timestamp
				if (updateClearTimerRef.current) {
					clearTimeout(updateClearTimerRef.current);
					updateClearTimerRef.current = null;
				}
				updateStatusShownAtRef.current = Date.now();
				setUpdateDownloadStatus(status); // "checking", "downloading", "error"
			}
		}
		window.addEventListener("rpc:updateDownloadProgress", onDownloadProgress);
		return () => {
			window.removeEventListener("rpc:updateDownloadProgress", onDownloadProgress);
			if (updateClearTimerRef.current) clearTimeout(updateClearTimerRef.current);
		};
	}, []);

	// Listen for Cmd+, (Settings menu item)
	useEffect(() => {
		function onNavigateToSettings() {
			navigate({ screen: "settings" });
		}
		window.addEventListener("rpc:navigateToSettings", onNavigateToSettings);
		return () => window.removeEventListener("rpc:navigateToSettings", onNavigateToSettings);
	}, [navigate]);

	// Listen for View > Gauge Demo menu item
	useEffect(() => {
		function onNavigateToGaugeDemo() {
			navigate({ screen: "gauge-demo" });
		}
		window.addEventListener("rpc:navigateToGaugeDemo", onNavigateToGaugeDemo);
		return () => window.removeEventListener("rpc:navigateToGaugeDemo", onNavigateToGaugeDemo);
	}, [navigate]);

	// Listen for View > Viewport Lab menu item
	useEffect(() => {
		function onNavigateToViewportLab() {
			navigate({ screen: "viewport-lab" });
		}
		window.addEventListener("rpc:navigateToViewportLab", onNavigateToViewportLab);
		return () => window.removeEventListener("rpc:navigateToViewportLab", onNavigateToViewportLab);
	}, [navigate]);

	// Listen for View > Remote Access QR Code menu item
	useEffect(() => {
		function onShowRemoteQR(e: Event) {
			const detail = (e as CustomEvent).detail;
			setRemoteQR(detail);
		}
		window.addEventListener("rpc:showRemoteAccessQR", onShowRemoteQR);
		return () => window.removeEventListener("rpc:showRemoteAccessQR", onShowRemoteQR);
	}, []);

	// Auto-refresh QR code every 25 seconds while modal is open (JWT tokens expire in 30s)
	const qrModalOpen = remoteQR !== null;
	const [qrCountdown, setQrCountdown] = useState(25);
	useEffect(() => {
		if (!qrModalOpen) return;
		setQrCountdown(25);
		const tick = setInterval(() => {
			setQrCountdown(prev => {
				if (prev <= 1) {
					// Refresh QR
					api.request.getRemoteAccessQR({ tunnel: tunnelWanted }).then(setRemoteQR).catch(() => {});
					return 25;
				}
				return prev - 1;
			});
		}, 1000);
		return () => clearInterval(tick);
	}, [qrModalOpen, tunnelWanted]);

	// Track page views on route changes
	useEffect(() => {
		const { screen } = state.route;
		trackPageView(screen);
	}, [state.route]);

	// Escape: close quit dialog or navigate back from settings screens
	// (skipped when a terminal has focus — Escape must reach the shell)
	useGlobalShortcut(
		(e) => {
			if (e.key !== "Escape") return;
			const terminalEl = document.querySelector('[data-terminal="true"]');
			if (terminalEl?.contains(document.activeElement)) return;
			if (showQuitDialog) {
				setShowQuitDialog(false);
				return;
			}
			const { route } = state;
			if (route.screen === "settings") {
				navigate({ screen: "dashboard" });
			} else if (route.screen === "project-settings") {
				navigate({ screen: "project", projectId: route.projectId });
			} else if (route.screen === "project-terminal") {
				navigate({ screen: "project", projectId: route.projectId });
			} else if (route.screen === "project" && route.activeTaskId) {
				navigate({ screen: "project", projectId: route.projectId });
			} else if (route.screen === "project") {
				navigate({ screen: "dashboard" });
			}
		},
		[state, navigate, showQuitDialog],
	);

	if (reqStatus === "checking") {
		return (
			<div className="h-full w-full flex items-center justify-center bg-base">
				<div className="flex items-center gap-3">
					<div className="w-2 h-2 rounded-full bg-accent animate-pulse" />
					<span className="text-fg-3 text-sm">{t("app.loading")}</span>
				</div>
			</div>
		);
	}

	if (reqStatus === "failed") {
		return (
			<RequirementsCheck
				results={reqResults}
				checking={reqChecking}
				onRefresh={checkRequirements}
				onRefreshResults={refreshResults}
			/>
		);
	}

	if (state.loading) {
		return (
			<div className="h-full w-full flex items-center justify-center bg-base">
				<div className="flex items-center gap-3">
					<div className="w-2 h-2 rounded-full bg-accent animate-pulse" />
					<span className="text-fg-3 text-sm">{t("app.loading")}</span>
				</div>
			</div>
		);
	}

	const { route } = state;

	return (
		<div className="h-full w-full flex flex-col">
			<GlobalHeader
				route={route}
				projects={state.projects}
				tasks={state.currentProjectTasks}
				navigate={navigate}
				updateVersion={updateVersion}
				updateDownloadStatus={updateDownloadStatus}
			/>
			{ghWarning && (
				<GhWarningBanner
					notInstalled={ghWarning.notInstalled}
					onDismiss={() => setGhWarning(null)}
				/>
			)}
			<div className="flex-1 min-h-0 flex flex-col overflow-hidden pb-7">{renderScreen()}</div>
			{pendingNavigation && (
				<div
					className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
					onMouseDown={(e) => {
						if (e.target === e.currentTarget) setPendingNavigation(null);
					}}
				>
					<div className="bg-overlay border border-edge rounded-2xl shadow-2xl w-[26.25rem] p-6 space-y-4">
						<h2 className="text-fg text-lg font-semibold">{t("unsavedChanges.title")}</h2>
						<p className="text-fg-2 text-sm leading-relaxed">{t("unsavedChanges.message")}</p>
						<div className="flex justify-end gap-2 pt-1">
							<button
								onClick={() => setPendingNavigation(null)}
								className="px-4 py-2 text-sm rounded-lg text-fg-2 hover:text-fg hover:bg-elevated transition-colors"
							>
								{t("unsavedChanges.cancel")}
							</button>
							<button
								onClick={() => {
									const route = pendingNavigation;
									navigationGuardRef.current = null;
									setPendingNavigation(null);
									dispatch({ type: "navigate", route });
								}}
								className="px-4 py-2 text-sm rounded-lg text-danger hover:bg-danger/10 transition-colors"
							>
								{t("unsavedChanges.discard")}
							</button>
							<button
								onClick={async () => {
									const route = pendingNavigation;
									if (navigationGuardRef.current) {
										await navigationGuardRef.current.onSave();
									}
									navigationGuardRef.current = null;
									setPendingNavigation(null);
									dispatch({ type: "navigate", route });
								}}
								className="px-4 py-2 text-sm rounded-lg bg-accent text-white hover:bg-accent-hover transition-colors"
							>
								{t("unsavedChanges.save")}
							</button>
						</div>
					</div>
				</div>
			)}
			{showQuitDialog && (
				<div
					className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
					onMouseDown={(e) => {
						if (e.target === e.currentTarget) setShowQuitDialog(false);
					}}
				>
					<div className="bg-overlay border border-edge rounded-2xl shadow-2xl w-[26.25rem] p-6 space-y-4">
						<h2 className="text-fg text-lg font-semibold">{t("quit.dialogTitle")}</h2>
						<p className="text-fg-2 text-sm leading-relaxed">{t("quit.dialogMessage")}</p>
						<label className="flex items-center gap-2.5 cursor-pointer select-none">
							<input
								type="checkbox"
								checked={dontShowAgain}
								onChange={(e) => setDontShowAgain(e.target.checked)}
								className="w-4 h-4 rounded accent-accent"
							/>
							<span className="text-fg-2 text-sm">{t("quit.dontShowAgain")}</span>
						</label>
						<div className="flex justify-end gap-2 pt-1">
							<button
								onClick={() => setShowQuitDialog(false)}
								className="px-4 py-2 text-sm rounded-lg text-fg-2 hover:text-fg hover:bg-elevated transition-colors"
							>
								{t("quit.cancel")}
							</button>
							<button
								onClick={handleConfirmQuit}
								className="px-4 py-2 text-sm rounded-lg bg-danger text-white hover:bg-danger/80 transition-colors"
							>
								{t("quit.confirm")}
							</button>
						</div>
					</div>
				</div>
			)}
			{remoteQR && (
				<div
					className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
					onMouseDown={(e) => {
						if (e.target === e.currentTarget) { setRemoteQR(null); setTunnelStarting(false); }
					}}
				>
					<div className="bg-overlay border border-edge rounded-2xl shadow-2xl w-[28rem] p-6 space-y-4 text-center">
						<h2 className="text-fg text-lg font-semibold">{t("remote.title")}</h2>
						<p className="text-fg-2 text-sm">{t("remote.subtitle")}</p>
						<div className="flex justify-center relative">
							<img src={remoteQR.qrDataUrl} alt="QR Code" className="w-56 h-56 rounded-lg" />
						</div>
						<div className="flex items-center justify-center gap-2 text-fg-muted text-xs">
							<div className="w-4 h-4 relative">
								<svg className="w-4 h-4 -rotate-90" viewBox="0 0 20 20">
									<circle cx="10" cy="10" r="8" fill="none" stroke="currentColor" strokeWidth="2" opacity="0.2" />
									<circle cx="10" cy="10" r="8" fill="none" stroke="currentColor" strokeWidth="2"
										strokeDasharray={`${(qrCountdown / 25) * 50.3} 50.3`}
										strokeLinecap="round"
										className="transition-all duration-1000 ease-linear"
									/>
								</svg>
							</div>
							<span>{t("remote.refreshIn", { seconds: String(qrCountdown) })}</span>
						</div>
						<div className="bg-base rounded-lg p-3">
							<code className="text-fg text-xs break-all select-all">{remoteQR.accessUrl}</code>
						</div>

						{/* Tunnel toggle */}
						<div className="bg-base rounded-lg p-3 text-left space-y-2">
							<label className="flex items-center gap-2 cursor-pointer select-none">
								<input
									type="checkbox"
									checked={tunnelWanted}
									onChange={(e) => {
										const want = e.target.checked;
										setTunnelWanted(want);
										if (want && remoteQR.cloudflaredInstalled && remoteQR.tunnelState === "idle") {
											setTunnelStarting(true);
											api.request.getRemoteAccessQR({ tunnel: true }).then((res) => {
												setRemoteQR(res);
												setTunnelStarting(false);
												setQrCountdown(25);
											}).catch(() => setTunnelStarting(false));
										} else if (!want && remoteQR.tunnelState === "connected") {
											api.request.stopTunnel().then(() => {
												api.request.getRemoteAccessQR({ tunnel: false }).then((res) => {
													setRemoteQR(res);
													setQrCountdown(25);
												}).catch(() => {});
											}).catch(() => {});
										}
									}}
									className="accent-accent w-4 h-4"
								/>
								<span className="text-fg text-sm">{t("remote.anywhereToggle")}</span>
							</label>

							{tunnelWanted && !remoteQR.cloudflaredInstalled && (
								<div className="text-left space-y-1.5">
									<p className="text-danger text-xs">{t("remote.cloudflaredNotFound")}</p>
									<p className="text-fg-muted text-xs">{t("remote.cloudflaredInstall")}</p>
									<button
										onClick={() => {
											api.request.getRemoteAccessQR({ tunnel: tunnelWanted }).then((res) => {
												setRemoteQR(res);
											}).catch(() => {});
										}}
										className="text-xs text-accent hover:text-accent-hover transition-colors"
									>
										{t("remote.recheckCloudflared")}
									</button>
								</div>
							)}

							{tunnelWanted && remoteQR.cloudflaredInstalled && (tunnelStarting || remoteQR.tunnelState === "starting") && (
								<div className="flex items-center gap-2">
									<div className="w-3 h-3 rounded-full bg-accent animate-pulse" />
									<span className="text-fg-3 text-xs">{t("remote.tunnelStarting")}</span>
								</div>
							)}

							{tunnelWanted && remoteQR.tunnelState === "connected" && (
								<div className="flex items-center gap-2">
									<div className="w-2 h-2 rounded-full bg-green-400" />
									<span className="text-green-400 text-xs">{t("remote.tunnelConnected")}</span>
								</div>
							)}

							{tunnelWanted && remoteQR.tunnelState === "failed" && (
								<div className="flex items-center gap-2">
									<div className="w-2 h-2 rounded-full bg-danger" />
									<span className="text-danger text-xs">{t("remote.tunnelFailed")}</span>
								</div>
							)}
						</div>

						<div className="flex items-center justify-center gap-2">
							<button
								onClick={() => {
									navigator.clipboard.writeText(remoteQR.accessUrl).catch(() => {});
								}}
								className="px-4 py-2 text-sm rounded-lg bg-accent text-white hover:bg-accent-hover transition-colors"
							>
								{t("remote.copyUrl")}
							</button>
							<button
								onClick={() => { setRemoteQR(null); setTunnelStarting(false); }}
								className="px-4 py-2 text-sm rounded-lg text-fg-2 hover:text-fg hover:bg-elevated transition-colors"
							>
								{t("remote.close")}
							</button>
						</div>
					</div>
				</div>
			)}
		</div>
	);

	function renderScreen() {
		switch (route.screen) {
			case "dashboard":
				return (
					<Dashboard
						projects={state.projects}
						dispatch={dispatch}
						navigate={navigate}
						bellCounts={state.bellCounts}
					/>
				);
			case "project":
				return (
					<ProjectView
						projectId={route.projectId}
						projects={state.projects}
						tasks={state.currentProjectTasks}
						dispatch={dispatch}
						navigate={navigate}
						bellCounts={state.bellCounts}
						taskPorts={state.taskPorts}
						taskResourceUsage={state.taskResourceUsage}
						activeTaskId={route.activeTaskId}
					/>
				);
			case "project-terminal": {
				const proj = state.projects.find((p) => p.id === route.projectId);
				return proj ? (
					<div className="flex-1 min-h-0 flex flex-col">
						<ProjectTerminal
							projectId={route.projectId}
							projectPath={proj.path}
							onBack={() => navigate({ screen: "project", projectId: route.projectId })}
						/>
					</div>
				) : null;
			}
			case "task":
				return (
					<TaskTerminal
						projectId={route.projectId}
						taskId={route.taskId}
						tasks={state.currentProjectTasks}
						projects={state.projects}
						navigate={navigate}
						dispatch={dispatch}
					/>
				);
			case "project-settings":
				return (
					<ProjectSettings
						projectId={route.projectId}
						projects={state.projects}
						tasks={state.currentProjectTasks}
						dispatch={dispatch}
						navigate={navigate}
						navigationGuardRef={navigationGuardRef}
						initialTab={route.tab}
						initialWorktreeTaskId={route.worktreeTaskId}
					/>
				);
			case "settings":
				return <GlobalSettings />;
			case "changelog":
				return (
					<Changelog
						navigate={navigate}
						goBack={() => dispatch({ type: "goBack" })}
						canGoBack={state.historyIndex > 0}
					/>
				);
			case "gauge-demo":
				return <GaugeDemo navigate={navigate} />;
			case "viewport-lab":
				return <ViewportLab navigate={navigate} />;
			default:
				return null;
		}
	}
}

export default App;
