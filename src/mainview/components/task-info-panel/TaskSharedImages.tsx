import type { Task } from "../../../shared/types";
import { useT } from "../../i18n";
import { ImagesIcon } from "../TaskIcons";

interface TaskSharedImagesProps {
	task: Task;
}

/**
 * Runtime & access bar control: re-open the task's shared-images viewer (images
 * an agent surfaced via `dev3 show-image`, §5.1). Renders ONLY when the task has
 * images — there is nothing to open otherwise, and hiding it keeps the Runtime
 * bar within its ≤4 visible-action budget in the common no-images case. Opens the
 * App-level lightbox at the newest image via the same `dev3:openImageViewer`
 * event the inspector badge used, so the viewer stays a single App-mounted host.
 */
export default function TaskSharedImages({ task }: TaskSharedImagesProps) {
	const t = useT();
	const count = task.sharedImages?.length ?? 0;
	if (count === 0) return null;

	const label = t("infoPanel.imagesBadge", { count: String(count) });
	return (
		<button
			type="button"
			onClick={() => window.dispatchEvent(new CustomEvent("dev3:openImageViewer", {
				detail: { taskId: task.id, images: task.sharedImages, index: count - 1 },
			}))}
			className="task-anim flex items-center gap-1 px-2 py-1 rounded-lg transition-colors flex-shrink-0 text-fg-2 hover:text-fg hover:bg-elevated-hover border border-edge"
			title={label}
			aria-label={label}
			data-testid="shared-images-badge"
		>
			<ImagesIcon className="w-[1.125rem] h-[1.125rem]" />
			<span className="text-[0.6875rem] font-semibold">{t("infoPanel.imagesLabel")}</span>
			<span className="text-[0.6875rem] font-semibold text-accent tabular-nums">{count}</span>
		</button>
	);
}
