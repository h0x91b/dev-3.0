import type { SharedArtifact, SharedImage, Task } from "../../shared/types";
import { latestArtifactVersion } from "../../shared/artifact-versions";
import { useT, type TFunction } from "../i18n";
import { formatBytes } from "../utils/formatBytes";
import { useImageDataUrl } from "../utils/useImageDataUrl";
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

/**
 * Every dev3 artifact is named `index.html`, so the filename says nothing. Show
 * what actually distinguishes one from another instead.
 */
function artifactMeta(artifact: SharedArtifact, t: TFunction): string {
	const parts: string[] = [];
	const version = latestArtifactVersion(artifact);
	if (version > 1) parts.push(`v${version}`);
	parts.push(formatBytes(artifact.bundleBytes ?? artifact.bytes));
	if (artifact.assets.length > 0) parts.push(t.plural("infoPanel.artifactAssets", artifact.assets.length));
	return parts.join(" · ");
}

const SECTION_HEADING = "flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-fg-2";
const CARD = "rounded-xl border border-edge bg-elevated text-left transition-colors hover:bg-elevated-hover hover:border-accent/50 group";

function SharedImageCard({ image, onOpen, t }: { image: SharedImage; onOpen: () => void; t: TFunction }) {
	const { dataUrl, error } = useImageDataUrl(image.storedPath);
	return (
		<button
			type="button"
			className={`${CARD} w-[10rem] p-2`}
			data-testid="shared-image-link"
			aria-label={t("infoPanel.openSharedImage", { name: image.name })}
			title={image.caption ? `${image.name} — ${image.caption}` : image.name}
			onClick={onOpen}
		>
			<span className="block h-[5.5rem] w-full overflow-hidden rounded bg-base">
				{dataUrl
					? <img src={dataUrl} alt="" className="img-edge h-full w-full rounded object-cover object-top" />
					: <span className={`flex h-full w-full items-center justify-center text-nano ${error ? "text-danger" : "text-fg-muted"}`}>
						{t(error ? "images.loadFailed" : "images.loading")}
					</span>}
			</span>
			<span className="mt-1.5 block truncate font-mono text-micro text-fg-2 group-hover:text-fg">{image.name}</span>
			{image.caption && <span className="mt-0.5 line-clamp-2 text-micro leading-snug text-fg-muted">{image.caption}</span>}
			<span className="mt-0.5 block text-nano tabular-nums text-fg-muted">{formatStamp(image.createdAt)}</span>
		</button>
	);
}

/**
 * Everything an agent surfaced for this task via `dev3 show-image` /
 * `dev3 show-artifact`. The live task reaches those viewers through the
 * Runtime-bar count badges; an archived task has no Runtime bar, so this list is
 * its entry point — and the single most common reason to reopen a finished task,
 * which is why it sits above the description rather than below it.
 *
 * Artifacts lead: they are the deliverable. Images render as a thumbnail grid,
 * because a list of filenames is the one thing an eye scrolling past a long
 * description cannot distinguish from more text. Renders nothing when the task
 * produced neither kind.
 */
export default function SharedOutputsList({ task, projectId }: SharedOutputsListProps) {
	const t = useT();
	const images: SharedImage[] = task.sharedImages ?? [];
	const artifacts: SharedArtifact[] = task.sharedArtifacts ?? [];
	if (images.length === 0 && artifacts.length === 0) return null;

	return (
		<div className="mb-6 flex flex-col gap-5" data-testid="shared-outputs-list">
			{artifacts.length > 0 && (
				<section aria-labelledby="shared-artifacts-heading">
					<h3 id="shared-artifacts-heading" className={SECTION_HEADING}>
						<ArtifactsIcon className="h-3.5 w-3.5 text-accent" />
						{t("infoPanel.artifactsLabel")}
						<span className="tabular-nums text-accent">{artifacts.length}</span>
					</h3>
					<div className="mt-2 flex flex-col gap-2">
						{artifacts.map((artifact, i) => (
							<button
								key={artifact.id}
								type="button"
								className={`${CARD} flex w-full items-center gap-3 px-3 py-2.5`}
								data-testid="shared-artifact-link"
								aria-label={t("infoPanel.openSharedArtifact", { name: artifact.title || artifact.name })}
								onClick={() => window.dispatchEvent(new CustomEvent("dev3:openArtifactViewer", {
									detail: { taskId: task.id, projectId, artifacts, index: i, standalone: true },
								}))}
							>
								<span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-accent/12 text-accent">
									<ArtifactsIcon className="h-[1.125rem] w-[1.125rem]" />
								</span>
								<span className="min-w-0 flex-1">
									<span className="block truncate text-sm font-medium text-fg-2 group-hover:text-fg">{artifact.title || artifact.name}</span>
									<span className="mt-0.5 block truncate text-micro tabular-nums text-fg-muted">{artifactMeta(artifact, t)}</span>
								</span>
								<span className="flex-shrink-0 text-micro tabular-nums text-fg-muted">{formatStamp(artifact.createdAt)}</span>
							</button>
						))}
					</div>
				</section>
			)}

			{images.length > 0 && (
				<section aria-labelledby="shared-images-heading">
					<h3 id="shared-images-heading" className={SECTION_HEADING}>
						<ImagesIcon className="h-3.5 w-3.5 text-accent" />
						{t("infoPanel.imagesLabel")}
						<span className="tabular-nums text-accent">{images.length}</span>
					</h3>
					<div className="mt-2 flex flex-wrap items-stretch gap-2">
						{images.map((image, i) => (
							<SharedImageCard
								key={image.id}
								image={image}
								t={t}
								onOpen={() => window.dispatchEvent(new CustomEvent("dev3:openImageViewer", {
									detail: { taskId: task.id, projectId, images, index: i },
								}))}
							/>
						))}
					</div>
				</section>
			)}
		</div>
	);
}
