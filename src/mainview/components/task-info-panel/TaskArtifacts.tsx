import type { Task } from "../../../shared/types";
import { useT } from "../../i18n";
import { ArtifactsIcon } from "../TaskIcons";
import Tooltip from "../Tooltip";

export default function TaskArtifacts({ task }: { task: Task }) {
	const t = useT();
	const count = task.sharedArtifacts?.length ?? 0;
	if (count === 0) return null;
	const label = t("infoPanel.artifactsBadge", { count: String(count) });
	return (
		<Tooltip content={label} detail={t("ttip.sharedArtifacts")}>
			<button
				type="button"
				onClick={() => window.dispatchEvent(new CustomEvent("dev3:openArtifactViewer", {
					detail: { taskId: task.id, artifacts: task.sharedArtifacts, index: count - 1 },
				}))}
				className="task-anim flex items-center gap-1 px-2 py-1 rounded-lg transition-colors flex-shrink-0 text-fg-2 hover:text-fg hover:bg-elevated-hover border border-edge"
				aria-label={label}
				data-testid="shared-artifacts-badge"
			>
				<ArtifactsIcon className="w-[1.125rem] h-[1.125rem]" />
				<span className="text-[0.6875rem] font-semibold">{t("infoPanel.artifactsLabel")}</span>
				<span className="text-[0.6875rem] font-semibold text-accent tabular-nums">{count}</span>
			</button>
		</Tooltip>
	);
}
