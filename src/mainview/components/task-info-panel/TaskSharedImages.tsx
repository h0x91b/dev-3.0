import type { Task } from "../../../shared/types";
import { useT } from "../../i18n";
import Tooltip from "../Tooltip";
import { ImagesIcon } from "../TaskIcons";

interface TaskSharedImagesProps {
	task: Task;
	projectId: string;
	/** Icon-only rendering (count kept) for a bar that is short on width. */
	compact?: boolean;
	/** Narrow-viewport sizing — grows the hit area to the 44px touch target. */
	touch?: boolean;
}

/**
 * Runtime & access bar control: re-open the task's shared-images viewer (images
 * an agent surfaced via `dev3 show-image`, §5.1). Renders ONLY when the task has
 * images — there is nothing to open otherwise, and hiding it keeps the Runtime
 * bar within its ≤4 visible-action budget in the common no-images case. Opens the
 * App-level lightbox at the newest image via the same `dev3:openImageViewer`
 * event the inspector badge used, so the viewer stays a single App-mounted host.
 */
export default function TaskSharedImages({ task, projectId, compact = false, touch = false }: TaskSharedImagesProps) {
	const t = useT();
	const count = task.sharedImages?.length ?? 0;
	if (count === 0) return null;

	const isUnread = task.sharedImages?.some((image) => image.isUnread) ?? false;
	const baseLabel = t.plural("infoPanel.imagesBadge", count);
	const label = isUnread ? `${baseLabel}. ${t("infoPanel.sharedItemsUnread")}` : baseLabel;
	return (
		<Tooltip content={label} detail={t("ttip.sharedImages")}>
			<button
				type="button"
				onClick={() => window.dispatchEvent(new CustomEvent("dev3:openImageViewer", {
					detail: { taskId: task.id, projectId, images: task.sharedImages, index: count - 1 },
				}))}
				className={`task-anim flex items-center gap-1 rounded-lg transition-colors flex-shrink-0 border ${touch ? "min-h-11 px-3" : "px-2 py-1"} ${isUnread
					? "text-success bg-success/15 border-success/40 hover:bg-success/25"
					: "text-fg-2 hover:text-fg hover:bg-elevated-hover border-edge"
				}`}
				aria-label={label}
				data-testid="shared-images-badge"
			>
				<ImagesIcon className={`w-[1.125rem] h-[1.125rem]${isUnread ? " task-shared-unread-icon" : ""}`} />
				{!compact && <span className="text-micro font-semibold">{t("infoPanel.imagesLabel")}</span>}
				<span className={`text-micro font-semibold tabular-nums ${isUnread ? "text-success" : "text-accent"}`}>{count}</span>
			</button>
		</Tooltip>
	);
}
