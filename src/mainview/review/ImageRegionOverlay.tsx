import { useRef, useState, type CSSProperties } from "react";
import type { ReviewComment, ReviewImageRegionAnchor } from "../../shared/review";
import { useT } from "../i18n";

export interface Region { x: number; y: number; w: number; h: number }

/** A click without a drag becomes a small box around the point. */
const POINT_REGION = 0.06;

export function clamp01(value: number): number {
	return Math.max(0, Math.min(1, value));
}

export function regionLabel(region: Region): string {
	const pct = (value: number) => `${Math.round(value * 100)}%`;
	return `x ${pct(region.x)}–${pct(region.x + region.w)}, y ${pct(region.y)}–${pct(region.y + region.h)}`;
}

/**
 * Where the picture actually paints inside its element: `object-contain`
 * letterboxes, so a normalised region has to be measured against the drawn
 * picture, not the element box. `fill` says the element box IS the picture.
 */
export function pictureContentRect(element: HTMLImageElement, fill: boolean): { left: number; top: number; width: number; height: number } {
	const box = element.getBoundingClientRect();
	if (fill || !element.naturalWidth || !element.naturalHeight) {
		return { left: box.left, top: box.top, width: box.width, height: box.height };
	}
	const scale = Math.min(box.width / element.naturalWidth, box.height / element.naturalHeight);
	const width = element.naturalWidth * scale;
	const height = element.naturalHeight * scale;
	return { left: box.left + (box.width - width) / 2, top: box.top + (box.height - height) / 2, width, height };
}

export function regionStyle(region: Region): CSSProperties {
	return { left: `${region.x * 100}%`, top: `${region.y * 100}%`, width: `${region.w * 100}%`, height: `${region.h * 100}%` };
}

interface ImageRegionOverlayProps {
	/** The drawn picture's box, in the coordinates of the positioned parent. */
	box: { left: number; top: number; width: number; height: number };
	/** Picking on: drags draw a region; off: only existing regions render, click-through otherwise. */
	picking: boolean;
	comments: ReviewComment[];
	activeCommentId: string | null;
	onActivate: (commentId: string) => void;
	/** The region awaiting text; drawn dashed until the comment is added or cancelled. */
	pendingRegion: Region | null;
	onPick: (region: Region) => void;
	testId?: string;
}

/**
 * The regions of an image's review comments, drawn over the picture, plus the
 * drag that makes a new one. Shared by the image viewer and the file preview so
 * the two never disagree on how a region is picked or drawn.
 */
export function ImageRegionOverlay({ box, picking, comments, activeCommentId, onActivate, pendingRegion, onPick, testId = "image-review" }: ImageRegionOverlayProps) {
	const t = useT();
	const dragStartRef = useRef<{ x: number; y: number } | null>(null);
	const [draft, setDraft] = useState<Region | null>(null);

	const pointOf = (event: React.PointerEvent<HTMLDivElement>) => {
		const rect = event.currentTarget.getBoundingClientRect();
		return { x: clamp01((event.clientX - rect.left) / rect.width), y: clamp01((event.clientY - rect.top) / rect.height) };
	};
	const regionFrom = (a: { x: number; y: number }, b: { x: number; y: number }): Region => ({
		x: Math.min(a.x, b.x),
		y: Math.min(a.y, b.y),
		w: Math.abs(a.x - b.x),
		h: Math.abs(a.y - b.y),
	});

	return (
		<div
			data-testid={`${testId}-overlay`}
			data-comment-mode={picking ? "true" : undefined}
			className={`absolute select-none ${picking ? "cursor-crosshair" : "pointer-events-none"}`}
			style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
			onPointerDown={(event) => {
				if (!picking || event.button !== 0) return;
				event.preventDefault();
				event.currentTarget.setPointerCapture?.(event.pointerId);
				dragStartRef.current = pointOf(event);
				setDraft({ ...dragStartRef.current, w: 0, h: 0 });
			}}
			onPointerMove={(event) => {
				if (!dragStartRef.current) return;
				setDraft(regionFrom(dragStartRef.current, pointOf(event)));
			}}
			onPointerUp={(event) => {
				const start = dragStartRef.current;
				if (!start) return;
				dragStartRef.current = null;
				let region = regionFrom(start, pointOf(event));
				if (region.w < 0.01 || region.h < 0.01) {
					const x = clamp01(start.x - POINT_REGION / 2);
					const y = clamp01(start.y - POINT_REGION / 2);
					region = { x, y, w: Math.min(POINT_REGION, 1 - x), h: Math.min(POINT_REGION, 1 - y) };
				}
				setDraft(null);
				onPick(region);
			}}
			onPointerCancel={() => { dragStartRef.current = null; setDraft(null); }}
		>
			{comments.map((comment, i) => {
				const anchor = comment.anchor as ReviewImageRegionAnchor;
				const resolved = Boolean(comment.resolvedAt);
				return (
					<button
						key={comment.id}
						type="button"
						data-testid={`${testId}-region`}
						data-resolved={resolved ? "true" : undefined}
						aria-label={t("infoPanel.diffReviewCommentItemOf", { number: String(i + 1), total: String(comments.length) })}
						onClick={(event) => { event.stopPropagation(); onActivate(comment.id); }}
						onPointerDown={(event) => event.stopPropagation()}
						className={`pointer-events-auto absolute rounded-sm border-2 ${resolved ? "border-success bg-success/10" : "border-accent bg-accent/15"} ${comment.id === activeCommentId ? "ring-2 ring-accent/40" : ""}`}
						style={regionStyle(anchor)}
					>
						<span className={`absolute -right-2.5 -top-2.5 flex h-5 w-5 items-center justify-center rounded-full text-micro font-bold text-white shadow ${resolved ? "bg-success" : "bg-accent"}`}>{i + 1}</span>
					</button>
				);
			})}
			{(draft ?? pendingRegion) && (
				<div
					data-testid={`${testId}-draft`}
					className="pointer-events-none absolute rounded-sm border-2 border-dashed border-accent bg-accent/10"
					style={regionStyle((draft ?? pendingRegion)!)}
				/>
			)}
		</div>
	);
}
