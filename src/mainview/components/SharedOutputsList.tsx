import type { SharedArtifact, SharedImage, Task } from "../../shared/types";
import { latestArtifactVersion } from "../../shared/artifact-versions";
import { useT } from "../i18n";
import { ArtifactsIcon, ImagesIcon } from "./TaskIcons";

interface SharedOutputsListProps {
	task: Task;
	projectId: string;
}

function formatStamp(ms: number): string {
	try {
		return new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
	} catch {
		return "";
	}
}

const ROW = "w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg border border-edge bg-raised text-left transition-colors hover:bg-elevated-hover hover:border-edge-active group";

/**
 * Enumerated links to everything an agent surfaced for this task via
 * `dev3 show-image` / `dev3 show-artifact`. The live task reaches those viewers
 * through the Runtime-bar count badges; an archived task has no Runtime bar, so
 * this list is its entry point — each row opens the App-hosted viewer at its own
 * index. Renders nothing when the task produced neither kind.
 */
export default function SharedOutputsList({ task, projectId }: SharedOutputsListProps) {
	const t = useT();
	const images: SharedImage[] = task.sharedImages ?? [];
	const artifacts: SharedArtifact[] = task.sharedArtifacts ?? [];
	if (images.length === 0 && artifacts.length === 0) return null;

	return (
		<div className="mb-6 flex flex-col gap-5" data-testid="shared-outputs-list">
			{images.length > 0 && (
				<section>
					<span className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-fg-3">
						<ImagesIcon className="h-3.5 w-3.5" />
						{t("infoPanel.imagesLabel")}
						<span className="tabular-nums text-fg-muted">{images.length}</span>
					</span>
					<div className="flex flex-col gap-1.5">
						{images.map((image, i) => (
							<button
								key={image.id}
								type="button"
								className={ROW}
								data-testid="shared-image-link"
								aria-label={t("infoPanel.openSharedImage", { name: image.name })}
								onClick={() => window.dispatchEvent(new CustomEvent("dev3:openImageViewer", {
									detail: { taskId: task.id, projectId, images, index: i },
								}))}
							>
								<span className="min-w-0 flex-1">
									<span className="block truncate font-mono text-xs text-fg-2 group-hover:text-fg">{image.name}</span>
									{image.caption && <span className="mt-0.5 block truncate text-micro text-fg-muted">{image.caption}</span>}
								</span>
								<span className="flex-shrink-0 text-micro tabular-nums text-fg-muted">{formatStamp(image.createdAt)}</span>
							</button>
						))}
					</div>
				</section>
			)}

			{artifacts.length > 0 && (
				<section>
					<span className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-fg-3">
						<ArtifactsIcon className="h-3.5 w-3.5" />
						{t("infoPanel.artifactsLabel")}
						<span className="tabular-nums text-fg-muted">{artifacts.length}</span>
					</span>
					<div className="flex flex-col gap-1.5">
						{artifacts.map((artifact, i) => (
							<button
								key={artifact.id}
								type="button"
								className={ROW}
								data-testid="shared-artifact-link"
								aria-label={t("infoPanel.openSharedArtifact", { name: artifact.title || artifact.name })}
								onClick={() => window.dispatchEvent(new CustomEvent("dev3:openArtifactViewer", {
									detail: { taskId: task.id, projectId, artifacts, index: i, standalone: true },
								}))}
							>
								<span className="min-w-0 flex-1">
									<span className="block truncate text-xs text-fg-2 group-hover:text-fg">{artifact.title || artifact.name}</span>
									<span className="mt-0.5 block truncate font-mono text-micro text-fg-muted">
										{artifact.name}
										{latestArtifactVersion(artifact) > 1 && ` · v${latestArtifactVersion(artifact)}`}
									</span>
								</span>
								<span className="flex-shrink-0 text-micro tabular-nums text-fg-muted">{formatStamp(artifact.createdAt)}</span>
							</button>
						))}
					</div>
				</section>
			)}
		</div>
	);
}
