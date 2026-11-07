import { createPortal } from "react-dom";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { TaskPrRefPreview } from "../../shared/task-refs";
import { useT } from "../i18n";
import { computeAnchoredPosition, type RectLike } from "../utils/popoverPosition";
import { prDisplayState, prStateTone } from "../utils/prStateTone";
import { taskPRBadgeFromStoredData } from "../utils/taskPrBadge";
import { taskCardAgent } from "../utils/taskCardAgent";
import { useAgents } from "../hooks/useAgents";
import { useNarrowViewport } from "../hooks/useNarrowViewport";
import { useStatusColors } from "../hooks/useStatusColors";
import { useProjectPrivacy } from "../sensitive-projects";
import { useTaskPrRefPreview, type PreviewState } from "../task-ref-preview";
import { CAROUSEL_MAX_WIDTH } from "./MobileBoardCarousel";
import { ImageThumbnail } from "./ImageThumbnail";
import { TaskRefText } from "./TaskRefText";
import AgentLauncherBadge from "./AgentLauncherBadge";
import LabelChip from "./LabelChip";
import PriorityBadge from "./PriorityBadge";
import TaskCardRail from "./TaskCardRail";
import TaskPrBadges from "./TaskPrBadges";
import { COORDINATOR_CARD_HALO, TaskRoleBand, taskRole } from "./TaskRoleBand";

const OPEN_DELAY_MS = 220;
const HIDE_DELAY_MS = 160;
/** A board card floats on the column's surface; the preview brings that surface along. */
const CARD_CLASS = "fixed z-[1200] w-[20rem] max-w-[90vw] rounded-xl bg-base text-xs shadow-popover";
const CARD_FACE_CLASS = "glass-card flex flex-col overflow-hidden rounded-xl border";
/** The card's own action-strip button (`+ Variant`). */
const CARD_ACTION_CLASS = "inline-flex flex-shrink-0 items-center gap-1.5 rounded-lg px-2 py-1 text-xs font-medium text-accent transition-[color,background-color,transform] duration-150 ease-out hover:bg-accent/15 motion-safe:active:scale-[0.96]";
const NERD_FONT = { fontFamily: "'JetBrainsMono Nerd Font Mono'" };

type TaskPreview = Extract<TaskPrRefPreview, { kind: "task" }>;
type PrPreview = Extract<TaskPrRefPreview, { kind: "pr" }>;

function Section({ title, children }: { title: string; children: ReactNode }) {
	return (
		<div className="mt-2.5">
			<div className="mb-1 text-dense font-semibold uppercase tracking-[0.07em] text-fg-3">{title}</div>
			{children}
		</div>
	);
}

/** The card's identity row, same classes as `task-card-identity`. */
function IdentityRow({ children }: { children: ReactNode }) {
	return <div className="flex min-w-0 items-center gap-1.5 border-b border-edge py-1.5 pl-1.5 pr-2.5">{children}</div>;
}

/** The card's bottom bar: read-only signals over a reserved action strip. */
function CardBar({ signals, children }: { signals?: ReactNode; children: ReactNode }) {
	return (
		<div className="border-t border-edge bg-base/50">
			{signals && <div className="flex min-w-0 flex-wrap items-center gap-1.5 px-2.5 py-1.5">{signals}</div>}
			<div className={`flex min-h-9 min-w-0 items-center justify-end gap-1 px-2 py-1.5 ${signals ? "border-t border-edge" : ""}`}>{children}</div>
		</div>
	);
}

/**
 * What a `<seq:N>` preview shows: the task's kanban card, read-only, built from the
 * board's own pieces (status strip, identity row, lifecycle rail, labels, PR
 * badges, action strip), with the overview, latest notes and media under the title.
 */
export function TaskRefPreviewBody({ preview, contextProjectId }: { preview: TaskPreview; contextProjectId?: string }) {
	const t = useT();
	const privacy = useProjectPrivacy();
	const statusColors = useStatusColors();
	const agents = useAgents();
	const { target, task } = preview;
	const color = preview.customColumn?.color ?? statusColors[target.status];
	const { agent, configLabel, hasLauncherIcon } = taskCardAgent(task, agents);
	const prInfo = taskPRBadgeFromStoredData(task);
	const role = taskRole(task);
	const moreImages = preview.imageCount - preview.images.length;
	const moreArtifacts = preview.artifactCount - preview.artifacts.length;
	const openTask = () => window.dispatchEvent(new CustomEvent("rpc:openDeepLink", {
		detail: { kind: "task", taskId: target.taskId, projectId: target.projectId },
	}));
	return (
		<div data-testid="task-ref-preview" className={`${CARD_FACE_CLASS} ${role === "coordinator" ? COORDINATOR_CARD_HALO : ""}`} style={{ borderColor: `${color}55` }}>
			<div aria-hidden="true" className="h-[3px] w-full flex-shrink-0" style={{ background: color }} />
			{role && <TaskRoleBand role={role} />}
			<IdentityRow>
				<PriorityBadge priority={task.priority} />
				<span className="flex-shrink-0 font-mono text-micro font-semibold text-accent">#{target.seq}</span>
				{agent && hasLauncherIcon && <AgentLauncherBadge agent={agent} />}
				{agent && !hasLauncherIcon && <span className="flex-shrink-0 font-mono text-dense font-medium text-accent/80">{agent.name}</span>}
				{configLabel
					? <span className="min-w-[3rem] flex-1 truncate font-mono text-dense font-medium text-accent/80" title={configLabel}>{configLabel}</span>
					: <div className="flex-1" />}
				{task.taskType === "pr-review" && (
					<span className="flex-shrink-0 text-dense font-semibold uppercase tracking-[0.06em] text-fg-3">{t("task.prReviewBadge")}</span>
				)}
			</IdentityRow>
			{/* Tall enough for a short rail word (TODO), as on the board. */}
			<div className="flex min-h-[7.5rem] min-w-0 items-stretch">
				<TaskCardRail
					readOnly
					autoLabel
					status={target.status}
					project={preview.customStatusLabels ? { customStatusLabels: preview.customStatusLabels } : null}
					customColumn={preview.customColumn}
					color={color}
				/>
				<div className="flex min-w-0 flex-1 flex-col">
					<div className="px-3 pb-3 pt-2.5">
						{target.projectId !== contextProjectId && (
							<div className={`truncate text-dense font-semibold uppercase tracking-[0.07em] text-fg-3 ${privacy.maskClass(target.projectId)}`}>
								{target.projectName}
							</div>
						)}
						<div className="break-words text-sm font-medium leading-relaxed text-fg line-clamp-3">{target.title}</div>
						{preview.labels.length > 0 && (
							<div className="mt-2 flex min-w-0 flex-wrap items-center gap-1">
								{preview.labels.map((label) => <LabelChip key={label.id} label={label} size="xs" />)}
							</div>
						)}
						{preview.overview && (
							<p className="mt-2 line-clamp-4 whitespace-pre-wrap break-words leading-relaxed text-fg-2">
								<TaskRefText text={preview.overview} contextProjectId={target.projectId} preview={false} />
							</p>
						)}
						{preview.notes.length > 0 && (
							<Section title={t("taskRef.previewNotes")}>
								<ul className="space-y-1.5">
									{preview.notes.map((note) => (
										<li key={note.id} className="line-clamp-3 whitespace-pre-wrap break-words leading-relaxed text-fg-2">
											<TaskRefText text={note.content} contextProjectId={target.projectId} preview={false} />
										</li>
									))}
								</ul>
							</Section>
						)}
						{preview.images.length > 0 && (
							<Section title={t("taskRef.previewImages")}>
								<div className="flex items-center gap-2 overflow-hidden">
									{preview.images.map((image, index) => (
										<ImageThumbnail
											key={image.id}
											path={image.storedPath}
											onClick={() => window.dispatchEvent(new CustomEvent("dev3:openImageViewer", {
												detail: { taskId: target.taskId, projectId: target.projectId, images: preview.images, index },
											}))}
										/>
									))}
									{moreImages > 0 && <span className="flex-shrink-0 text-fg-3">{t.plural("taskRef.previewMore", moreImages)}</span>}
								</div>
							</Section>
						)}
						{preview.artifacts.length > 0 && (
							<Section title={t("taskRef.previewArtifacts")}>
								<ul className="space-y-0.5">
									{preview.artifacts.map((artifact, index) => (
										<li key={artifact.id}>
											<button
												type="button"
												className="w-full truncate rounded px-1 py-0.5 text-left text-accent transition-colors hover:bg-accent/10 hover:text-accent-emphasis"
												onClick={() => window.dispatchEvent(new CustomEvent("dev3:openArtifactViewer", {
													detail: { taskId: target.taskId, taskStatus: target.status, projectId: target.projectId, artifacts: preview.artifacts, index, paneless: true },
												}))}
											>
												{artifact.title}
											</button>
										</li>
									))}
								</ul>
								{moreArtifacts > 0 && <div className="mt-0.5 text-fg-3">{t.plural("taskRef.previewMore", moreArtifacts)}</div>}
							</Section>
						)}
					</div>
					<div className="mt-auto">
						<CardBar signals={prInfo ? <TaskPrBadges prInfo={prInfo} projectId={target.projectId} taskId={target.taskId} /> : undefined}>
							<button type="button" data-testid="task-ref-preview-open" className={CARD_ACTION_CLASS} onClick={openTask}>
								{t("taskRef.previewOpen")}
							</button>
						</CardBar>
					</div>
				</div>
			</div>
		</div>
	);
}

/**
 * The PR side for surfaces that cannot host `TaskPrStatusPopover` as a trigger
 * (the terminal has no element to anchor it): the board's own PR badges, the
 * title and CI, and the way out to GitHub.
 */
export function PrRefSummary({ preview }: { preview: PrPreview }) {
	const t = useT();
	const { badge, target } = preview;
	const url = badge?.url || target.url || "";
	const prInfo = badge ?? { number: target.number, url };
	const tone = prStateTone(prDisplayState(badge?.mergeState?.state, badge?.isDraft));
	const ci = badge?.ciStatus;
	return (
		<div data-testid="pr-ref-summary" className={CARD_FACE_CLASS}>
			<IdentityRow>
				<TaskPrBadges prInfo={prInfo} projectId={target.projectId} taskId={target.taskId} />
				<div className="flex-1" />
				{tone.labelKey && <span className={`flex-shrink-0 text-micro font-semibold ${tone.text}`}>{t(tone.labelKey)}</span>}
			</IdentityRow>
			<div className="px-3 pb-3 pt-2.5">
				{badge?.prTitle
					? <div className="break-words text-sm font-medium leading-relaxed text-fg line-clamp-3">{badge.prTitle}</div>
					: <div className="leading-relaxed text-fg-3">{t("task.prNotLoaded")}</div>}
				{ci && (
					<div className={`mt-1.5 ${ci === "success" ? "text-success" : ci === "failure" ? "text-danger" : "text-warning-strong"}`}>
						{t("task.prChecks")}: {t(ci === "success" ? "task.prCheckPassed" : ci === "failure" ? "task.prCheckFailed" : "task.prCheckPending")}
					</div>
				)}
			</div>
			{url && (
				<CardBar>
					<a href={url} target="_blank" rel="noopener noreferrer" data-testid="pr-ref-summary-open" className={CARD_ACTION_CLASS}>
						<span aria-hidden="true" className="leading-none" style={NERD_FONT}>{"\u{F0401}"}</span>
						{t("task.openPR", { number: String(target.number) })}
					</a>
				</CardBar>
			)}
		</div>
	);
}

function PreviewContent({ state, contextProjectId }: { state: PreviewState; contextProjectId?: string }) {
	const t = useT();
	if (state.status !== "ready") return <div className={`${CARD_FACE_CLASS} p-3 text-fg-3`}>{t("taskRef.previewLoading")}</div>;
	if (!state.preview) return <div className={`${CARD_FACE_CLASS} p-3 text-fg-3`}>{t("taskRef.previewNotFound")}</div>;
	return state.preview.kind === "task"
		? <TaskRefPreviewBody preview={state.preview} contextProjectId={contextProjectId} />
		: <PrRefSummary preview={state.preview} />;
}

function usePlacedCard(anchor: RectLike | null) {
	const cardRef = useRef<HTMLDivElement | null>(null);
	const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
	const place = useCallback(() => {
		if (!anchor || !cardRef.current) return;
		const next = computeAnchoredPosition(anchor, { width: cardRef.current.offsetWidth, height: cardRef.current.offsetHeight }, { placement: "bottom", align: "start" });
		// Re-placed on every render (the content grows as the preview loads); bail
		// out when nothing moved, or the state update would loop.
		setPosition((prev) => (prev && prev.top === next.top && prev.left === next.left ? prev : { top: next.top, left: next.left }));
	}, [anchor]);
	useLayoutEffect(place);
	return { cardRef, position };
}

function rectOf(element: Element): RectLike {
	const r = element.getBoundingClientRect();
	return { top: r.top, left: r.left, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
}

interface TaskRefHoverCardProps {
	refUri: string;
	contextProjectId?: string;
	children: ReactNode;
}

/**
 * Hover preview around an inline `<seq:N>` link. Hover-only: on touch the tap
 * opens the task, which carries the same facts.
 */
export function TaskRefHoverCard({ refUri, contextProjectId, children }: TaskRefHoverCardProps) {
	const narrow = useNarrowViewport(CAROUSEL_MAX_WIDTH);
	const { state, load } = useTaskPrRefPreview(refUri, contextProjectId);
	const [anchor, setAnchor] = useState<RectLike | null>(null);
	const triggerRef = useRef<HTMLSpanElement | null>(null);
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const { cardRef, position } = usePlacedCard(anchor);

	const clear = () => {
		if (timer.current) clearTimeout(timer.current);
		timer.current = null;
	};
	const scheduleOpen = () => {
		if (narrow) return;
		clear();
		timer.current = setTimeout(() => {
			if (!triggerRef.current) return;
			load();
			setAnchor(rectOf(triggerRef.current));
		}, OPEN_DELAY_MS);
	};
	const scheduleHide = () => {
		clear();
		timer.current = setTimeout(() => setAnchor(null), HIDE_DELAY_MS);
	};
	useEffect(() => clear, []);
	useEffect(() => {
		if (!anchor) return;
		const close = () => setAnchor(null);
		const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
		const onScroll = (event: Event) => {
			if (event.target instanceof Node && cardRef.current?.contains(event.target)) return;
			close();
		};
		document.addEventListener("keydown", onKey, true);
		window.addEventListener("scroll", onScroll, true);
		return () => {
			document.removeEventListener("keydown", onKey, true);
			window.removeEventListener("scroll", onScroll, true);
		};
	}, [anchor, cardRef]);

	return (
		<span ref={triggerRef} className="inline" onMouseEnter={scheduleOpen} onMouseLeave={scheduleHide}>
			{children}
			{anchor && createPortal(
				<div
					ref={cardRef}
					role="tooltip"
					data-testid="task-ref-hover-card"
					className={CARD_CLASS}
					style={{ top: position?.top ?? -9999, left: position?.left ?? -9999, visibility: position ? "visible" : "hidden" }}
					onMouseEnter={clear}
					onMouseLeave={scheduleHide}
					onClick={(event) => event.stopPropagation()}
				>
					<PreviewContent state={state} contextProjectId={contextProjectId} />
				</div>,
				document.body,
			)}
		</span>
	);
}

interface TaskRefFloatingPreviewProps {
	/** The hovered reference and the cell it sits in, or null once the pointer left it. */
	hover: { uri: string; anchor: RectLike } | null;
	contextProjectId?: string;
}

/**
 * Preview for a reference in the terminal, where the link is canvas pixels and
 * not an element: the terminal reports the hovered cell, this card follows it.
 */
export function TaskRefFloatingPreview({ hover, contextProjectId }: TaskRefFloatingPreviewProps) {
	const [shown, setShown] = useState<{ uri: string; anchor: RectLike } | null>(null);
	const insideCard = useRef(false);
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const { state, load } = useTaskPrRefPreview(shown?.uri ?? "", contextProjectId);
	const { cardRef, position } = usePlacedCard(shown?.anchor ?? null);

	useEffect(() => {
		if (timer.current) clearTimeout(timer.current);
		if (hover) {
			if (hover.uri === shown?.uri) return;
			timer.current = setTimeout(() => setShown(hover), OPEN_DELAY_MS);
		} else {
			timer.current = setTimeout(() => { if (!insideCard.current) setShown(null); }, HIDE_DELAY_MS);
		}
		return () => { if (timer.current) clearTimeout(timer.current); };
	}, [hover, shown?.uri]);
	useEffect(() => { if (shown) load(); }, [load, shown]);

	// The canvas cannot style a link, so the hovered one gets the same chip tint
	// a reference has in React text, painted over its cells.
	const chip = hover && createPortal(
		<div
			aria-hidden="true"
			data-testid="terminal-ref-chip"
			className="pointer-events-none fixed z-[1100] rounded-[0.3125rem] bg-accent/15 ring-1 ring-accent/40"
			style={{ top: hover.anchor.top - 1, left: hover.anchor.left - 3, width: hover.anchor.width + 6, height: hover.anchor.height + 2 }}
		/>,
		document.body,
	);
	if (!shown) return chip || null;
	return <>{chip}{createPortal(
		<div
			ref={cardRef}
			role="tooltip"
			data-testid="task-ref-floating-preview"
			className={CARD_CLASS}
			style={{ top: position?.top ?? -9999, left: position?.left ?? -9999, visibility: position ? "visible" : "hidden" }}
			onMouseEnter={() => { insideCard.current = true; }}
			onMouseLeave={() => { insideCard.current = false; setShown(null); }}
		>
			<PreviewContent state={state} contextProjectId={contextProjectId} />
		</div>,
		document.body,
	)}</>;
}
