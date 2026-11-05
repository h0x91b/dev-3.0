import { createPortal } from "react-dom";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { STATUS_COLORS } from "../../shared/types";
import type { TaskPrRefPreview } from "../../shared/task-refs";
import { statusKey, useT } from "../i18n";
import { computeAnchoredPosition, type RectLike } from "../utils/popoverPosition";
import { prDisplayState, prStateTone } from "../utils/prStateTone";
import { useNarrowViewport } from "../hooks/useNarrowViewport";
import { useProjectPrivacy } from "../sensitive-projects";
import { useTaskPrRefPreview, type PreviewState } from "../task-ref-preview";
import { CAROUSEL_MAX_WIDTH } from "./MobileBoardCarousel";
import { ImageThumbnail } from "./ImageThumbnail";
import { TaskRefText } from "./TaskRefText";
import PriorityBadge from "./PriorityBadge";

const OPEN_DELAY_MS = 220;
const HIDE_DELAY_MS = 160;
const CARD_CLASS = "fixed z-[1200] w-[22rem] max-w-[90vw] overflow-hidden rounded-xl border border-edge-active bg-overlay text-xs shadow-popover";
const FOOTER_ACTION_CLASS = "inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs font-medium text-accent transition-[color,background-color,transform] duration-150 ease-out hover:bg-accent/15 hover:text-accent-emphasis motion-safe:active:scale-[0.96]";
const NERD_FONT = { fontFamily: "'JetBrainsMono Nerd Font Mono'" };

type TaskPreview = Extract<TaskPrRefPreview, { kind: "task" }>;
type PrPreview = Extract<TaskPrRefPreview, { kind: "pr" }>;

function Section({ title, children }: { title: string; children: ReactNode }) {
	return (
		<div className="mt-3">
			<div className="mb-1 text-dense font-medium uppercase tracking-wider text-fg-muted">{title}</div>
			{children}
		</div>
	);
}

/** The kanban card's identity row: who this is, before what it says. */
function IdentityRow({ children }: { children: ReactNode }) {
	return <div className="flex min-w-0 items-center gap-1.5 border-b border-edge py-1.5 pl-2 pr-2.5">{children}</div>;
}

function Footer({ children }: { children: ReactNode }) {
	return <div className="flex items-center justify-end border-t border-edge bg-base/50 px-2 py-1">{children}</div>;
}

/** What a `<seq:N>` preview shows, dressed like its kanban card: status strip, identity row, title. */
export function TaskRefPreviewBody({ preview, contextProjectId }: { preview: TaskPreview; contextProjectId?: string }) {
	const t = useT();
	const privacy = useProjectPrivacy();
	const { target } = preview;
	const color = STATUS_COLORS[target.status];
	const moreImages = preview.imageCount - preview.images.length;
	const moreArtifacts = preview.artifactCount - preview.artifacts.length;
	const openTask = () => window.dispatchEvent(new CustomEvent("rpc:openDeepLink", {
		detail: { kind: "task", taskId: target.taskId, projectId: target.projectId },
	}));
	return (
		<div data-testid="task-ref-preview">
			<div aria-hidden="true" className="h-[3px] w-full" style={{ background: color }} />
			<IdentityRow>
				<PriorityBadge priority={preview.priority} />
				<span className="flex-shrink-0 font-mono text-micro font-semibold text-accent">#{target.seq}</span>
				{target.projectId !== contextProjectId && (
					<span className={`min-w-0 truncate text-micro text-fg-3 ${privacy.maskClass(target.projectId)}`}>{target.projectName}</span>
				)}
				<span className="ml-auto flex flex-shrink-0 items-center gap-1.5 text-micro font-medium" style={{ color }}>
					<span aria-hidden="true" className="h-1.5 w-1.5 rounded-full" style={{ background: color }} />
					{t(statusKey(target.status))}
				</span>
			</IdentityRow>
			<div className="px-3 pb-3 pt-2">
				<div className="break-words text-sm font-medium leading-relaxed text-fg line-clamp-3">{target.title}</div>
				{preview.overview && (
					<p className="mt-1.5 whitespace-pre-wrap break-words text-fg-2">
						<TaskRefText text={preview.overview} contextProjectId={target.projectId} preview={false} />
					</p>
				)}
				{preview.notes.length > 0 && (
					<Section title={t("taskRef.previewNotes")}>
						<ul className="space-y-1.5">
							{preview.notes.map((note) => (
								<li key={note.id} className="line-clamp-3 whitespace-pre-wrap break-words text-fg-2">
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
										className="w-full truncate rounded px-1 py-0.5 text-left text-accent hover:bg-overlay-hover hover:text-accent-emphasis"
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
			<Footer>
				<button type="button" data-testid="task-ref-preview-open" className={FOOTER_ACTION_CLASS} onClick={openTask}>
					{t("taskRef.previewOpen")}
				</button>
			</Footer>
		</div>
	);
}

/**
 * The PR side for surfaces that cannot host `TaskPrStatusPopover` (the terminal
 * has no React trigger to anchor it): identity, lifecycle and CI in one glance.
 */
export function PrRefSummary({ preview }: { preview: PrPreview }) {
	const t = useT();
	const { badge, target } = preview;
	const tone = prStateTone(prDisplayState(badge?.mergeState?.state, badge?.isDraft));
	const ci = badge?.ciStatus;
	const url = badge?.url || target.url;
	return (
		<div data-testid="pr-ref-summary">
			<IdentityRow>
				<span className="flex-shrink-0 font-mono text-micro font-semibold text-accent">{t("task.prNumber", { number: String(target.number) })}</span>
				{tone.labelKey && <span className={`ml-auto flex-shrink-0 text-micro font-medium ${tone.text}`}>{t(tone.labelKey)}</span>}
			</IdentityRow>
			<div className="px-3 pb-3 pt-2">
				{badge?.prTitle
					? <div className="break-words text-sm font-medium leading-relaxed text-fg line-clamp-3">{badge.prTitle}</div>
					: <div className="text-fg-muted">{t("task.prNotLoaded")}</div>}
				{ci && (
					<div className={`mt-1.5 ${ci === "success" ? "text-success" : ci === "failure" ? "text-danger" : "text-warning-strong"}`}>
						{t("task.prChecks")}: {t(ci === "success" ? "task.prCheckPassed" : ci === "failure" ? "task.prCheckFailed" : "task.prCheckPending")}
					</div>
				)}
			</div>
			{url && (
				<Footer>
					<a href={url} target="_blank" rel="noopener noreferrer" data-testid="pr-ref-summary-open" className={FOOTER_ACTION_CLASS}>
						<span aria-hidden="true" className="leading-none" style={NERD_FONT}>{"\u{F0401}"}</span>
						{t("task.openPR", { number: String(target.number) })}
					</a>
				</Footer>
			)}
		</div>
	);
}

function PreviewContent({ state, contextProjectId }: { state: PreviewState; contextProjectId?: string }) {
	const t = useT();
	if (state.status !== "ready") return <div className="p-3 text-fg-muted">{t("taskRef.previewLoading")}</div>;
	if (!state.preview) return <div className="p-3 text-fg-muted">{t("taskRef.previewNotFound")}</div>;
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

	if (!shown) return null;
	return createPortal(
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
	);
}
