import type { Task } from "../../shared/types";
import { useT } from "../i18n";
import { api } from "../rpc";
import { toast } from "../toast";
import EpicSelect from "./EpicSelect";

/**
 * The "Epic" row of a task's metadata grid (label + value cells). Changing it
 * moves only this task: its children keep whatever epic they have.
 */
function TaskEpicRow({ task, testId = "task-epic-row" }: { task: Task; testId?: string }) {
	const t = useT();
	async function setEpic(epicId: string | null) {
		if ((task.epicId ?? null) === epicId) return;
		try {
			await api.request.setTaskEpic({ projectId: task.projectId, taskId: task.id, epicId });
		} catch (err) {
			toast.error(t("epic.setFailed", { error: String(err) }), { projectId: task.projectId });
		}
	}
	return (
		<>
			<span className="self-center text-fg-3">{t("epic.row")}</span>
			<span data-testid={testId} className="flex min-w-0 max-w-xs text-xs">
				<EpicSelect value={task.epicId ?? null} onChange={(id) => void setEpic(id)} />
			</span>
		</>
	);
}

export default TaskEpicRow;
