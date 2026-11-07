import { useEffect, useMemo, useState } from "react";
import type { LaunchAfterUntil, Project, Task } from "../../shared/types";
import { getTaskTitle } from "../../shared/types";
import { api } from "../rpc";
import { useT } from "../i18n";
import Select, { type SelectOption } from "./Select";

export interface StartAfterChoice {
	prerequisiteId: string | null;
	until: LaunchAfterUntil;
}

/**
 * Tasks this one may wait for: same board, not itself or its own variants, not
 * cancelled, not already waiting on it. A variant group is offered once, by its
 * lowest variant, because the whole group counts as the prerequisite.
 */
export function startAfterCandidates(task: Task, tasks: Task[]): Task[] {
	const seenGroups = new Set<string>();
	return tasks
		.filter((t) => t.id !== task.id
			&& !(task.groupId != null && t.groupId === task.groupId)
			&& t.status !== "cancelled"
			&& t.launchAfter?.taskId !== task.id)
		.sort((a, b) => (a.variantIndex ?? 0) - (b.variantIndex ?? 0))
		.filter((t) => {
			if (t.groupId == null) return true;
			if (seenGroups.has(t.groupId)) return false;
			seenGroups.add(t.groupId);
			return true;
		})
		.sort((a, b) => Number(a.status === "completed") - Number(b.status === "completed") || b.seq - a.seq);
}

/** The "After task" mode of the launch modal's Launch later panel. */
function StartAfterPicker({ task, project, value, disabled = false, onChange }: {
	task: Task;
	project: Project;
	value: StartAfterChoice;
	disabled?: boolean;
	onChange: (next: StartAfterChoice) => void;
}) {
	const t = useT();
	const [tasks, setTasks] = useState<Task[] | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);

	useEffect(() => {
		let live = true;
		api.request.getTasks({ projectId: project.id })
			.then((all) => { if (live) setTasks(all); })
			.catch((err) => { if (live) setLoadError(String(err)); });
		return () => { live = false; };
	}, [project.id]);

	const candidates = useMemo(() => (tasks ? startAfterCandidates(task, tasks) : []), [task, tasks]);
	const options: SelectOption[] = candidates.map((c) => ({ value: c.id, label: `#${c.seq} ${getTaskTitle(c)}` }));
	const chosen = candidates.find((c) => c.id === value.prerequisiteId) ?? null;

	const hint = loadError
		? loadError
		: !tasks
			? t("launch.afterLoading")
			: candidates.length === 0
				? t("launch.afterNoTasks")
				: chosen
					? t(value.until === "merged" ? "launch.afterHintMerged" : "launch.afterHintCompleted", { seq: String(chosen.seq) })
					: t("launch.afterPickHint");

	return (
		<div>
			<div className="flex flex-wrap items-center gap-4">
				<div className="min-w-[14rem] flex-1">
					<Select
						value={value.prerequisiteId ?? ""}
						options={options}
						onChange={(id) => onChange({ ...value, prerequisiteId: id })}
						searchable
						growList
						placeholder={t("launch.afterPickTask")}
						searchPlaceholder={t("launch.afterSearch")}
						ariaLabel={t("launch.afterTaskLabel")}
						emptyLabel={t("launch.afterNoMatch")}
					/>
				</div>
				<div
					role="group"
					aria-label={t("launch.afterUntilLabel")}
					className="inline-flex h-8 flex-shrink-0 items-center rounded-lg border border-edge p-0.5"
				>
					{(["completed", "merged"] as const).map((until) => (
						<button
							key={until}
							type="button"
							disabled={disabled}
							aria-pressed={value.until === until}
							onClick={() => onChange({ ...value, until })}
							className={`text-sm px-2.5 py-1 rounded-md whitespace-nowrap transition-colors ${
								value.until === until ? "bg-overlay-hover text-fg font-medium" : "text-fg-3 hover:text-fg"
							}`}
						>
							{until === "merged" ? t("launch.afterUntilMerged") : t("launch.afterUntilCompleted")}
						</button>
					))}
				</div>
			</div>
			<p className={`text-sm mt-2 ${loadError ? "text-danger" : "text-fg-3"}`}>{hint}</p>
		</div>
	);
}

export default StartAfterPicker;
