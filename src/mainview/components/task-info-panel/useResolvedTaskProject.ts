import { useEffect, useState } from "react";
import type { Project, Task } from "../../../shared/types";
import { api } from "../../rpc";
import { startVisibilityAwarePoll } from "../../utils/poll";

export function useResolvedTaskProject(task: Task, project: Project): Project {
	const [resolvedProject, setResolvedProject] = useState(project);

	useEffect(() => {
		if (!task.worktreePath) {
			setResolvedProject(project);
			return;
		}

		let cancelled = false;

		const fetchResolved = () => {
			api.request.getResolvedProject({ projectId: project.id, worktreePath: task.worktreePath! })
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
	}, [project, project.id, task.worktreePath]);

	return resolvedProject;
}
