// Resolve a parsed `dev3://…` deep link against on-disk data, verifying the
// referenced task/project exists and picking a fallback project for `new-task`
// links that omit one. Returns null when nothing usable can be resolved (bad
// id, or no projects exist at all) so the caller can ignore the open quietly.

import { loadProjects, loadTasks, loadVirtualProjects } from "./data";
import { loadSpacesFile } from "./spaces-data";
import type { Project } from "../shared/types";
import type { DeepLinkNav, DeepLinkTarget } from "../shared/deep-link";

// Git projects + virtual ("Operations") boards, same merge the UI uses.
async function allProjects(): Promise<Project[]> {
	const [gitProjects, virtualProjects] = await Promise.all([loadProjects(), loadVirtualProjects()]);
	return [...gitProjects, ...virtualProjects];
}

export async function resolveDeepLink(target: DeepLinkTarget): Promise<DeepLinkNav | null> {
	const projects = await allProjects();

	switch (target.kind) {
		case "task": {
			for (const project of projects) {
				const tasks = await loadTasks(project);
				if (tasks.some((t) => t.id === target.taskId)) {
					return { kind: "task", taskId: target.taskId, projectId: project.id };
				}
			}
			return null;
		}
		case "project": {
			const found = projects.find((p) => p.id === target.projectId);
			return found ? { kind: "project", projectId: found.id } : null;
		}
		case "space": {
			// A space board opens ON a project, so a space whose members are all gone
			// from this machine is as dead as a deleted one: the caller ignores it and
			// the renderer lands the user on the dashboard.
			const file = await loadSpacesFile();
			const space = file.spaces.find((s) => s.id === target.spaceId && !s.deleted);
			const projectId = space?.projectIds.find((id) => projects.some((p) => p.id === id));
			return projectId ? { kind: "space", spaceId: target.spaceId, projectId } : null;
		}
		case "new-task": {
			const requested = target.projectId && projects.some((p) => p.id === target.projectId) ? target.projectId : undefined;
			const projectId = requested ?? projects[0]?.id;
			if (!projectId) return null;
			return { kind: "new-task", projectId, text: target.text ?? "" };
		}
	}
}
