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
		if (currentRoute.screen !== "task") return;
		const task = state.currentProjectTasks.find(
			(t) => t.id === currentRoute.taskId,
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

	// Close settings screens with Escape
	useEffect(() => {
		function onKeyDown(e: KeyboardEvent) {
			if (e.key !== "Escape") return;
			const { route } = state;
			if (route.screen === "settings") {
				navigate({ screen: "dashboard" });
			} else if (route.screen === "project-settings") {
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
