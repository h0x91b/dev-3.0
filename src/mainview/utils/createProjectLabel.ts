import type { Dispatch } from "react";
import type { Label, Project } from "../../shared/types";
import type { AppAction } from "../state";
import type { TFunction } from "../i18n";
import { api } from "../rpc";
import { toast } from "../toast";

/**
 * Create a label on a project and make it available project-wide at once.
 * Reports a failure as a toast and rethrows, so a picker only has to stop its spinner.
 */
export async function createProjectLabel({ project, name, dispatch, t, taskId }: {
	project: Project;
	name: string;
	dispatch: Dispatch<AppAction>;
	t: TFunction;
	taskId?: string;
}): Promise<Label> {
	try {
		const label = await api.request.createLabel({ projectId: project.id, name });
		dispatch({ type: "updateProject", project: { ...project, labels: [...(project.labels ?? []), label] } });
		return label;
	} catch (err) {
		toast.error(t("labels.failedCreate", { error: String(err) }), { taskId });
		throw err;
	}
}
