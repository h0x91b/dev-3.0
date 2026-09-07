import type { Task } from "../../../shared/types";
import { useT } from "../../i18n";
import { ArtifactsIcon } from "../TaskIcons";
import Tooltip from "../Tooltip";

/** `paneless`: rendered by a surface with no workspace pane behind it (the task
 *  detail modal), so the viewer it opens stays a popup instead of docking. */
export default function TaskArtifacts({ task, projectId, compact = false, touch = false, paneless = false }: { task: Task; projectId: string; compact?: boolean; touch?: boolean; paneless?: boolean }) {
	const t = useT();
	const count = task.sharedArtifacts?.length ?? 0;
	if (count === 0) return null;
	const isUnread = task.sharedArtifacts?.some((artifact) => artifact.isUnread) ?? false;
	const baseLabel = t.plural("infoPanel.artifactsBadge", count);
	const label = isUnread ? `${baseLabel}. ${t("infoPanel.sharedItemsUnread")}` : baseLabel;
	return (
		<Tooltip content={label} detail={t("ttip.sharedArtifacts")}>
			<button
				type="button"
				onClick={() => window.dispatchEvent(new CustomEvent("dev3:openArtifactViewer", {
					detail: { taskId: task.id, taskStatus: task.status, projectId, artifacts: task.sharedArtifacts, index: count - 1, paneless },
				}))}
				className={`task-anim flex items-center gap-1 rounded-lg transition-colors flex-shrink-0 border ${touch ? "min-h-11 px-3" : "px-2 py-1"} ${isUnread
					? "text-success bg-success/15 border-success/40 hover:bg-success/25"
					: "text-fg-2 hover:text-fg hover:bg-elevated-hover border-edge"
				}`}
				aria-label={label}
				data-testid="shared-artifacts-badge"
			>
				<ArtifactsIcon className={`w-[1.125rem] h-[1.125rem]${isUnread ? " task-shared-unread-icon" : ""}`} />
				{!compact && <span className="text-micro font-semibold">{t("infoPanel.artifactsLabel")}</span>}
				<span className={`text-micro font-semibold tabular-nums ${isUnread ? "text-success" : "text-accent"}`}>{count}</span>
			</button>
		</Tooltip>
	);
}
