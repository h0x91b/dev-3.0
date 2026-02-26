import { useEffect, useCallback } from "react";
import { useAppState, type Route } from "./state";
import { api } from "./rpc";
import { useT } from "./i18n";
import GlobalHeader from "./components/GlobalHeader";
import GlobalSettings from "./components/GlobalSettings";
import Dashboard from "./components/Dashboard";
import ProjectView from "./components/ProjectView";
import TaskTerminal from "./components/TaskTerminal";
import SubPanel from "./components/SubPanel";
import ProjectSettings from "./components/ProjectSettings";

function App() {
	const [state, dispatch] = useAppState();
	const t = useT();

	const navigate = useCallback(
		(route: Route) => dispatch({ type: "navigate", route }),
		[dispatch],
	);

	// Load projects on mount
	useEffect(() => {
		(async () => {
			try {
				const projects = await api.request.getProjects();
				dispatch({ type: "setProjects", projects });
			} catch (err) {
				console.error("Failed to load projects:", err);
			}
			dispatch({ type: "setLoading", loading: false });
		})();
	}, [dispatch]);

	// Listen for push messages from bun
	useEffect(() => {
		function onTaskUpdated(e: Event) {
			const { task } = (e as CustomEvent).detail;
			dispatch({ type: "updateTask", task });
		}
		window.addEventListener("rpc:taskUpdated", onTaskUpdated);
		return () => window.removeEventListener("rpc:taskUpdated", onTaskUpdated);
	}, [dispatch]);

	// Listen for Cmd+, (Settings menu item)
	useEffect(() => {
		function onNavigateToSettings() {
			navigate({ screen: "settings" });
		}
		window.addEventListener("rpc:navigateToSettings", onNavigateToSettings);
		return () => window.removeEventListener("rpc:navigateToSettings", onNavigateToSettings);
	}, [navigate]);

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
				dispatch={dispatch}
			/>
			{route.screen === "task" && (() => {
				const task = state.currentProjectTasks.find((t) => t.id === route.taskId);
				const project = state.projects.find((p) => p.id === route.projectId);
				return task && project ? <SubPanel task={task} project={project} /> : null;
			})()}
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
					/>
				);
			case "task":
				return (
					<TaskTerminal
						projectId={route.projectId}
						taskId={route.taskId}
						tasks={state.currentProjectTasks}
						navigate={navigate}
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
			default:
				return null;
		}
	}
}

export default App;
