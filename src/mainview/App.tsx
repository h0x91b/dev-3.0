import { useEffect, useCallback } from "react";
import { useAppState, type Route } from "./state";
import { api } from "./rpc";
import Dashboard from "./components/Dashboard";
import ProjectView from "./components/ProjectView";
import TaskTerminal from "./components/TaskTerminal";
import ProjectSettings from "./components/ProjectSettings";

function App() {
	const [state, dispatch] = useAppState();

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

	if (state.loading) {
		return (
			<div className="h-screen w-screen flex items-center justify-center bg-[#1a1b26]">
				<span className="text-[#565f89] text-sm">Loading...</span>
			</div>
		);
	}

	const { route } = state;

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
		default:
			return null;
	}
}

export default App;
