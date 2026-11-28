import { useEffect, useRef } from "react";
import type { ReviewFramePoint } from "../../shared/review";
import { useT } from "../i18n";

const ICON = "'JetBrainsMono Nerd Font Mono'";

export interface StageBox {
	left: number;
	top: number;
	width: number;
	height: number;
}

/**
 * Where a contained video's picture sits inside its element box: the element
 * can be wider or taller than the picture (letterboxing), and the spots are
 * normalised to the picture, not to the element.
 */
export function containedPictureBox(box: StageBox, natural: { w: number; h: number } | null): StageBox {
	if (!natural || natural.w <= 0 || natural.h <= 0 || box.width <= 0 || box.height <= 0) return box;
	const scale = Math.min(box.width / natural.w, box.height / natural.h);
	const width = natural.w * scale;
	const height = natural.h * scale;
	return { left: box.left + (box.width - width) / 2, top: box.top + (box.height - height) / 2, width, height };
}

/** A pointer position as 0..1 of the picture, rounded past what a click can mean; null outside it. */
export function normalisedSpot(picture: { left: number; top: number; width: number; height: number }, clientX: number, clientY: number): { x: number; y: number } | null {
	if (picture.width <= 0 || picture.height <= 0) return null;
	const x = (clientX - picture.left) / picture.width;
	const y = (clientY - picture.top) / picture.height;
	if (x < 0 || x > 1 || y < 0 || y > 1) return null;
	const round = (value: number) => Math.round(value * 10000) / 10000;
	return { x: round(x), y: round(y) };
}

interface VideoFrameSpotsProps {
	/** The drawn picture, relative to the stage. */
	box: StageBox;
	/** Spots of the comment being written; editable. */
	draft: ReviewFramePoint[];
	/** Spots of stored comments on this frame; drawn, not editable. */
	saved: { commentId: string; points: ReviewFramePoint[]; active: boolean }[];
	/** The marking tool is on: a click on the picture adds a spot. */
	placing: boolean;
	selected: number | null;
	onSelect: (n: number | null) => void;
	onAdd: (spot: { x: number; y: number }) => void;
	onRemove: (n: number) => void;
}

function Crosshair({ point, tone }: { point: ReviewFramePoint; tone: "draft" | "saved" | "quiet" }) {
	const line = tone === "quiet" ? "bg-fg-muted" : "bg-warning";
	return (
		<span aria-hidden="true" className="pointer-events-none absolute h-7 w-7 -translate-x-1/2 -translate-y-1/2" style={{ left: `${point.x * 100}%`, top: `${point.y * 100}%` }}>
			<span className={`absolute left-0 top-1/2 h-0.5 w-2.5 -translate-y-1/2 ${line} shadow-[0_0_0_1px_rgb(0_0_0/0.6)]`} />
			<span className={`absolute right-0 top-1/2 h-0.5 w-2.5 -translate-y-1/2 ${line} shadow-[0_0_0_1px_rgb(0_0_0/0.6)]`} />
			<span className={`absolute left-1/2 top-0 h-2.5 w-0.5 -translate-x-1/2 ${line} shadow-[0_0_0_1px_rgb(0_0_0/0.6)]`} />
			<span className={`absolute bottom-0 left-1/2 h-2.5 w-0.5 -translate-x-1/2 ${line} shadow-[0_0_0_1px_rgb(0_0_0/0.6)]`} />
		</span>
	);
}

const BADGE = "flex h-5 min-w-5 items-center justify-center rounded-full bg-black/75 px-1 font-mono text-micro font-semibold leading-none text-white tabular-nums";

/**
 * Numbered crosshairs over a paused video frame. Spots are stored as 0..1 of the
 * picture, so they land on the same pixel at any size, in fullscreen and with
 * letterboxing. Spots of the comment being written can be selected and removed
 * (click, then × or Delete); a stored comment's spots are only drawn.
 */
export default function VideoFrameSpots({ box, draft, saved, placing, selected, onSelect, onAdd, onRemove }: VideoFrameSpotsProps) {
	const t = useT();
	const selectedRef = useRef<HTMLButtonElement | null>(null);
	useEffect(() => { selectedRef.current?.focus(); }, [selected]);

	return (
		<div
			data-testid="video-spots"
			data-placing={placing ? "true" : undefined}
			className={`absolute ${placing ? "cursor-crosshair" : "pointer-events-none"}`}
			style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
			onPointerDown={placing ? (e) => {
				if (e.button !== 0 || e.target !== e.currentTarget) return;
				const spot = normalisedSpot(e.currentTarget.getBoundingClientRect(), e.clientX, e.clientY);
				if (spot) onAdd(spot);
			} : undefined}
		>
			{saved.flatMap(({ commentId, points, active }) => points.map((point) => (
				<span key={`${commentId}:${point.n}`} data-testid="video-spot-saved" className="pointer-events-none">
					<Crosshair point={point} tone={active ? "saved" : "quiet"} />
					<span aria-hidden="true" className={`absolute ${BADGE} ${active ? "ring-2 ring-warning" : "opacity-70"}`} style={{ left: `calc(${point.x * 100}% + 10px)`, top: `calc(${point.y * 100}% - 26px)` }}>{point.n}</span>
				</span>
			)))}
			{draft.map((point) => {
				const isSelected = point.n === selected;
				return (
					<span key={point.n} data-testid="video-spot" data-spot={point.n}>
						<Crosshair point={point} tone="draft" />
						<span className="absolute flex items-center gap-0.5" style={{ left: `calc(${point.x * 100}% + 10px)`, top: `calc(${point.y * 100}% - 26px)` }}>
							<button
								type="button"
								ref={isSelected ? selectedRef : undefined}
								aria-label={t("imageViewer.spot", { n: String(point.n) })}
								aria-pressed={isSelected}
								onPointerDown={(e) => e.stopPropagation()}
								onClick={() => onSelect(isSelected ? null : point.n)}
								onKeyDown={(e) => {
									if (e.key !== "Delete" && e.key !== "Backspace") return;
									e.preventDefault();
									e.stopPropagation();
									onRemove(point.n);
								}}
								className={`pointer-events-auto ${BADGE} ring-2 outline-none transition-transform duration-150 ease-[cubic-bezier(0.2,0,0,1)] active:scale-[0.96] ${isSelected ? "ring-accent" : "ring-warning"} focus-visible:ring-accent`}
							>
								{point.n}
							</button>
							{isSelected && (
								<button
									type="button"
									aria-label={t("imageViewer.removeSpot", { n: String(point.n) })}
									title={t("imageViewer.removeSpot", { n: String(point.n) })}
									data-testid="video-spot-remove"
									onPointerDown={(e) => e.stopPropagation()}
									onClick={() => onRemove(point.n)}
									className="pointer-events-auto flex h-5 w-5 items-center justify-center rounded-full bg-black/75 text-dense text-white transition-[background-color,transform] duration-150 ease-[cubic-bezier(0.2,0,0,1)] hover:bg-danger active:scale-[0.96]"
								>
									<span aria-hidden="true" style={{ fontFamily: ICON }}>{"\uf00d"}</span>
								</button>
							)}
						</span>
					</span>
				);
			})}
		</div>
	);
}
