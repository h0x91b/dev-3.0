import { useState, useEffect, useCallback } from "react";
import { useAppState, type Route } from "./state";
import { api } from "./rpc";
import { useT } from "./i18n";
import { trackPageView } from "./analytics";
import type { RequirementCheckResult } from "../shared/types";
import GlobalHeader from "./components/GlobalHeader";
import GlobalSettings from "./components/GlobalSettings";
import Dashboard from "./components/Dashboard";
import ProjectView from "./components/ProjectView";
import TaskTerminal from "./components/TaskTerminal";
import ProjectSettings from "./components/ProjectSettings";
import RequirementsCheck from "./components/RequirementsCheck";
import Changelog from "./components/Changelog";

function App() {
	const [state, dispatch] = useAppState();
	const t = useT();

	// Quit dialog
	const [showQuitDialog, setShowQuitDialog] = useState(false);
	const [dontShowAgain, setDontShowAgain] = useState(false);

	// System requirements gate
	const [reqStatus, setReqStatus] = useState<"checking" | "failed" | "passed">("checking");
	const [reqResults, setReqResults] = useState<RequirementCheckResult[]>([]);
	const [reqChecking, setReqChecking] = useState(false);

	const checkRequirements = useCallback(async () => {
		setReqChecking(true);
		try {
			const results = await api.request.checkSystemRequirements();
			setReqResults(results);
			const allOk = results.every((r) => r.installed);
			setReqStatus(allOk ? "passed" : "failed");
		} catch (err) {
			console.error("Failed to check system requirements:", err);
			// If we can't check, assume OK to avoid blocking the app
			setReqStatus("passed");
		}
		setReqChecking(false);
	}, []);

	useEffect(() => {
		checkRequirements();
	}, [checkRequirements]);

	const navigate = useCallback(
		(route: Route) => dispatch({ type: "navigate", route }),
		[dispatch],
	);

	// Cmd+Q / Cmd+, — intercept before ghostty-web terminal can swallow them
	useEffect(() => {
		function handleKeyDown(e: KeyboardEvent) {
			if (e.metaKey && e.key === "q") {
				e.preventDefault();
				e.stopPropagation();
				const skip = localStorage.getItem("dev3-skip-quit-dialog") === "true";
				if (skip) {
					api.request.quitApp().catch(() => {});
				} else {
					setShowQuitDialog(true);
				}
			} else if (e.metaKey && e.key === ",") {
				e.preventDefault();
				e.stopPropagation();
				navigate({ screen: "settings" });
			}
		}
		window.addEventListener("keydown", handleKeyDown, { capture: true });
		return () => window.removeEventListener("keydown", handleKeyDown, { capture: true });
	}, [navigate]);

	function handleConfirmQuit() {
		if (dontShowAgain) {
			localStorage.setItem("dev3-skip-quit-dialog", "true");
		}
		api.request.quitApp().catch(() => {});
	}

	// Load projects on mount — gated on requirements passing
	useEffect(() => {
		if (reqStatus !== "passed") return;
		(async () => {
			try {
				const projects = await api.request.getProjects();
				dispatch({ type: "setProjects", projects });
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
		function onTerminalBell(e: Event) {
			const { taskId } = (e as CustomEvent).detail;
			dispatch({ type: "addBell", taskId });
		}
		window.addEventListener("rpc:terminalBell", onTerminalBell);
		return () => window.removeEventListener("rpc:terminalBell", onTerminalBell);
	}, [dispatch]);

	// Auto-move task back to "in-progress" when user opens its terminal
	useEffect(() => {
		const currentRoute = state.route;
		let viewingTaskId: string | undefined;
		if (currentRoute.screen === "task") {
			viewingTaskId = currentRoute.taskId;
		} else if (currentRoute.screen === "project" && currentRoute.activeTaskId) {
			viewingTaskId = currentRoute.activeTaskId;
		}
		if (!viewingTaskId) return;
		const task = state.currentProjectTasks.find(
			(t) => t.id === viewingTaskId,
		);
		if (task && task.status === "user-questions") {
			api.request
				.moveTask({
					taskId: task.id,
					projectId: task.projectId,
					newStatus: "in-progress",
				})
				.catch((err) =>
					console.error("Failed to auto-move task to in-progress:", err),
				);
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [state.route]);

	// Listen for Cmd+, (Settings menu item)
	useEffect(() => {
		function onNavigateToSettings() {
			navigate({ screen: "settings" });
		}
		window.addEventListener("rpc:navigateToSettings", onNavigateToSettings);
		return () => window.removeEventListener("rpc:navigateToSettings", onNavigateToSettings);
	}, [navigate]);

	// Track page views on route changes
	useEffect(() => {
		const { screen } = state.route;
		trackPageView(screen);
	}, [state.route]);

	// Close settings screens / split view with Escape
	useEffect(() => {
		function onKeyDown(e: KeyboardEvent) {
			if (e.key !== "Escape") return;
			// Don't intercept Escape when a terminal has focus
			const terminalEl = document.querySelector('[data-terminal="true"]');
			if (terminalEl?.contains(document.activeElement)) return;
			const { route } = state;
			if (route.screen === "settings") {
				navigate({ screen: "dashboard" });
			} else if (route.screen === "project-settings") {
				navigate({ screen: "project", projectId: route.projectId });
			} else if (route.screen === "project" && route.activeTaskId) {
				navigate({ screen: "project", projectId: route.projectId });
			}
		}
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [state, navigate]);

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
			/>
			<div className="flex-1 min-h-0 flex flex-col">{renderScreen()}</div>
			{showQuitDialog && (
				<div
					className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
					onMouseDown={(e) => {
						if (e.target === e.currentTarget) setShowQuitDialog(false);
					}}
				>
					<div className="bg-overlay border border-edge rounded-2xl shadow-2xl w-[420px] p-6 space-y-4">
						<h2 className="text-fg text-lg font-semibold">{t("quit.dialogTitle")}</h2>
						<p className="text-fg-2 text-sm leading-relaxed">{t("quit.dialogMessage")}</p>
						<label className="flex items-center gap-2.5 cursor-pointer select-none">
							<input
								type="checkbox"
								checked={dontShowAgain}
								onChange={(e) => setDontShowAgain(e.target.checked)}
								className="w-4 h-4 rounded accent-[var(--color-accent)]"
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
						activeTaskId={route.activeTaskId}
					/>
				);
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
						dispatch={dispatch}
						navigate={navigate}
					/>
				);
			case "settings":
				return <GlobalSettings />;
			case "changelog":
				return <Changelog navigate={navigate} previousRoute={state.previousRoute} />;
			default:
				return null;
		}
	}
}

export default App;
