import { useEffect, useState } from "react";
import type { Project, Task } from "../../../shared/types";
import { api } from "../../rpc";
import { startVisibilityAwarePoll } from "../../utils/poll";

/**
 * The task's effective project config — the worktree's `.dev3/` files layered
 * over the main checkout's, exactly as a dev-server start resolves them. The
 * task is resolved backend-side, so a task with no worktree yet still sees the
 * main checkout's config instead of the bare projects.json record.
 */
export function useResolvedTaskProject(task: Task, project: Project): Project {
	const [resolvedProject, setResolvedProject] = useState(project);

	useEffect(() => {
		let cancelled = false;

		const fetchResolved = () => {
			api.request.getResolvedProject({ projectId: project.id, taskId: task.id })
				.then((nextProject) => {
					if (!cancelled) {
						setResolvedProject(nextProject);
					}
				})
				.catch(() => {
					if (!cancelled) {
						setResolvedProject(project);
					}
				});
		};

		const stop = startVisibilityAwarePoll({ fn: fetchResolved, intervalMs: 10_000 });

		return () => {
			cancelled = true;
			stop();
		};
	}, [project, project.id, task.id]);

	return resolvedProject;
}
