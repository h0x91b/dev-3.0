import type { ReactNode } from "react";
import type { Task } from "../../shared/types";
import { taskOrigin } from "../../shared/types";
import { useTaskLineage } from "../hooks/useTaskLineage";
import { useT } from "../i18n";
import type { Route } from "../state";
import { useProjectPrivacy } from "../sensitive-projects";
import { lineageParent, parentSeqLabel } from "../utils/taskLineage";

/**
 * The "Created by" row of a task's metadata grid (label + value cells). Nothing
 * for a task the user created; a link to the parent when `navigate` is given.
 */
function TaskOriginRow({ task, navigate, testId = "task-origin-row" }: { task: Task; navigate?: (route: Route) => void; testId?: string }) {
	const t = useT();
	const lineage = useTaskLineage();
	const { maskClass } = useProjectPrivacy();
	const origin = taskOrigin(task);
	if (origin.kind === "user") return null;

	let value: ReactNode;
	if (origin.kind === "automation") value = <span className="text-fg-3">{t("infoPanel.createdByAutomation")}</span>;
	else if (origin.kind === "import") value = <span className="text-fg-3">{t("infoPanel.createdByImport")}</span>;
	else {
		const parent = lineageParent(task, lineage);
		if (parent === null) {
			value = <span className="text-fg-muted">…</span>;
		} else if (parent === "deleted") {
			value = <span className="text-fg-3">{t("infoPanel.createdByDeleted")}</span>;
		} else {
			const text = (
				<>
					<span className="font-mono font-semibold">{parentSeqLabel(parent)}</span>
					{" · "}
					<span className={maskClass(parent.projectId)}>{parent.projectName}</span>
				</>
			);
			value = navigate ? (
				<button
					type="button"
					data-testid={`${testId}-link`}
					title={parent.title}
					onClick={() => navigate({ screen: "project", projectId: parent.projectId, taskDetailId: parent.id })}
					className="min-w-0 truncate text-left text-accent hover:text-accent-emphasis hover:underline focus-visible:ring-1 focus-visible:ring-accent rounded"
				>
					{text}
				</button>
			) : (
				<span className="min-w-0 truncate text-fg-2" title={parent.title}>{text}</span>
			);
		}
	}

	return (
		<>
			<span className="text-fg-3">{t("infoPanel.createdBy")}</span>
			<span data-testid={testId} className="flex min-w-0">{value}</span>
		</>
	);
}

export default TaskOriginRow;
