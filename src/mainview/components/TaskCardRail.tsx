import { useLayoutEffect, useRef, useState, type Ref } from "react";
import type { Project, TaskStatus } from "../../shared/types";
import { useT, type TranslationKey } from "../i18n";
import { getStatusLabel } from "../utils/statusLabel";
import { PIPELINE_STAGES, getPipelineIndex } from "./StatusPipeline";
import PipelineRing, { CompleteCheckIcon } from "./PipelineRing";
import Tooltip from "./Tooltip";

/**
 * How many upright letters a rail can stack before it out-grows a short card.
 * An upright letter is ~11px tall, and the shortest card body is ~110px once the
 * ring, the bell slot and the ✓ have taken their share.
 */
export const RAIL_LABEL_MAX = 8;

const RAIL_LABEL_CLASS =
	"max-h-32 overflow-hidden font-mono text-dense font-extrabold uppercase leading-none tracking-[0.14em] [text-orientation:upright] [writing-mode:vertical-rl]";

/** Short, uppercase rail forms of the built-in statuses. The full label stays in
 *  the rail's accessible name and tooltip, and in the Move-to menu. */
const RAIL_LABEL_KEY: Record<TaskStatus, TranslationKey> = {
	todo: "status.rail.todo",
	"in-progress": "status.rail.inProgress",
	"user-questions": "status.rail.userQuestions",
	"review-by-ai": "status.rail.reviewByAi",
	"review-by-user": "status.rail.reviewByUser",
	"review-by-colleague": "status.rail.reviewByColleague",
	completed: "status.rail.completed",
	cancelled: "status.rail.cancelled",
};

/**
 * A custom column has no short form of its own — clip its name and shout it.
 * A whole first word beats a mid-word cut: "On hold" reads as ON, not "ON H".
 */
export function shortenForRail(name: string, max: number = RAIL_LABEL_MAX): string {
	const trimmed = name.trim();
	if (trimmed.length <= max) return trimmed.toUpperCase();
	const firstWord = trimmed.split(/\s+/)[0];
	if (firstWord.length <= max) return firstWord.toUpperCase();
	return trimmed.slice(0, max).trim().toUpperCase();
}

interface TaskCardRailProps {
	status: TaskStatus;
	project: Project;
	/** Set when the task sits in a custom column: its own name and dot colour win. */
	customColumn?: { name: string; color: string } | null;
	/** STATUS_COLORS[status], or the custom column's colour. Inline-styled — the
	 *  documented per-status hex exception, same as PipelineRing itself. */
	color: string;
	/** Accumulated `dev3 attention` count. Lives here because attention is a
	 *  lifecycle fact, and a card-corner badge overlapped the ring. */
	bellCount?: number;
	/** Rail is inert while the task is preparing, moving, hibernated or tearing down. */
	disabled?: boolean;
	canComplete: boolean;
	completing: boolean;
	onOpenMenu: (e: React.MouseEvent) => void;
	onComplete: (e: React.MouseEvent) => void;
	menuTriggerRef: Ref<HTMLButtonElement>;
	/** Narrow viewport: widen so both halves clear the 44px touch minimum. */
	touch?: boolean;
	/**
	 * Show the upright word only when the rail is tall enough to hold it whole.
	 * Set by the Active Tasks sidebar, where a row is 88px when it carries a
	 * title and 273px when it carries an overview: a stacked word would set the
	 * short row's height instead of describing it. A card is always tall enough,
	 * so it leaves this off and always shows the word.
	 */
	autoLabel?: boolean;
}

/**
 * The card's LIFECYCLE zone: everything that changes or reports which column the
 * task is in, and nothing else. Two stacked buttons rather than one — a ✓ nested
 * inside the status button would be invalid markup and unreachable by keyboard.
 */
export default function TaskCardRail({
	status,
	project,
	customColumn,
	color,
	bellCount = 0,
	disabled = false,
	canComplete,
	completing,
	onOpenMenu,
	onComplete,
	menuTriggerRef,
	touch = false,
	autoLabel = false,
}: TaskCardRailProps) {
	const t = useT();
	const stage = getPipelineIndex(status) + 1;
	const total = PIPELINE_STAGES.length;
	const fullLabel = customColumn ? customColumn.name : getStatusLabel(status, t, project);
	const railLabel = customColumn ? shortenForRail(customColumn.name) : t(RAIL_LABEL_KEY[status]);
	const stageLabel = t("pipeline.stageOf", { current: String(stage), total: String(total) });
	const railRef = useRef<HTMLDivElement>(null);
	const [labelFits, setLabelFits] = useState(!autoLabel);

	// Measured: an upright letter is ~14.4px, and the ring, the ✓ and the rail's
	// own padding claim ~58px before the word starts. With `autoLabel` the word is
	// taken out of flow (see below), so the height it measures never includes the
	// word itself — otherwise the first fit would latch and the row could not shrink.
	const neededForLabel = 58 + railLabel.length * 14.4;
	useLayoutEffect(() => {
		if (!autoLabel) return;
		const el = railRef.current;
		if (!el || typeof ResizeObserver === "undefined") return;
		const measure = () => setLabelFits(el.getBoundingClientRect().height >= neededForLabel);
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(el);
		return () => observer.disconnect();
	}, [autoLabel, neededForLabel]);

	return (
		<div
			ref={railRef}
			data-testid="task-card-rail"
			className={`flex flex-shrink-0 flex-col items-stretch self-stretch rounded-bl-[0.6875rem] ${touch ? "w-11" : "w-5"}`}
			style={{ background: `${color}22` }}
		>
			<Tooltip content={fullLabel} detail={`${stageLabel} · ${t("task.moveTo")}`}>
				<button
					ref={menuTriggerRef}
					type="button"
					onClick={onOpenMenu}
					disabled={disabled}
					aria-label={`${fullLabel} — ${stageLabel}. ${t("task.moveTo")}`}
					className={`flex w-full flex-1 flex-col items-center rounded-tl-none rounded-bl-none pb-1.5 transition-[filter] duration-150 ease-out hover:brightness-125 disabled:cursor-not-allowed disabled:opacity-60 motion-safe:active:scale-[0.97] ${touch ? "gap-1.5 pt-2" : "gap-1 pt-1.5"}`}
				>
					{customColumn ? (
						<span
							className={`flex-shrink-0 rounded-full ${touch ? "h-[0.9375rem] w-[0.9375rem]" : "h-2.5 w-2.5"}`}
							style={{ background: color, boxShadow: `0 0 6px ${color}60` }}
						/>
					) : (
						<PipelineRing status={status} size={touch ? "default" : "compact"} tooltip={false} />
					)}

					{bellCount > 0 && (
						<span
							data-testid="task-card-rail-bell"
							className={`flex flex-shrink-0 items-center justify-center rounded-full bg-red-500 font-bold leading-none text-white shadow-[0_2px_6px_rgb(239_68_68_/_0.45)] ${touch ? "h-4 min-w-4 px-1 text-dense" : "h-3.5 min-w-3.5 px-0.5 text-nano"}`}
						>
							{bellCount > 9 ? "9+" : bellCount}
						</span>
					)}

					{/* Upright stacked letters — read straight down, never rotated. The
					    accessible name above carries the full label, so the visual
					    abbreviation is hidden from assistive tech. */}
					{labelFits &&
						(autoLabel ? (
							// Out of flow: the word must never add to the height that decides
							// whether it fits, or a row that once had room keeps it forever.
							<span className="relative flex min-h-0 w-full flex-1 justify-center overflow-hidden">
								<span aria-hidden="true" className={`absolute top-0 ${RAIL_LABEL_CLASS}`} style={{ color }}>
									{railLabel}
								</span>
							</span>
						) : (
							<span aria-hidden="true" className={RAIL_LABEL_CLASS} style={{ color }}>
								{railLabel}
							</span>
						))}
				</button>
			</Tooltip>

			{canComplete && (
				<Tooltip content={t("pipeline.completeTooltip")} disabled={completing}>
					<button
						data-testid="task-card-quick-complete"
						type="button"
						onClick={onComplete}
						disabled={completing}
						aria-label={t("pipeline.completeTooltip")}
						className={`flex w-full flex-shrink-0 items-center justify-center rounded-bl-[0.6875rem] text-success transition-[opacity,background-color,transform] duration-150 ease-out motion-safe:active:scale-[0.96] ${touch ? "h-11" : "h-7"} ${
							completing ? "bg-success/25 opacity-100" : "opacity-70 hover:bg-success/20 hover:opacity-100"
						}`}
					>
						{/* Both glyphs stay mounted and cross-fade — a hard swap on a
						    12px target reads as a flicker. */}
						<span className="relative flex h-3.5 w-3.5 items-center justify-center">
							<span
								className={`absolute inset-0 h-3.5 w-3.5 animate-spin rounded-full border-2 border-success/30 border-t-success transition-[opacity,transform,filter] duration-300 ease-[cubic-bezier(0.2,0,0,1)] ${completing ? "opacity-100 scale-100 blur-0" : "opacity-0 scale-[0.25] blur-[4px]"}`}
							/>
							<CompleteCheckIcon
								className={`absolute inset-0 h-3.5 w-3.5 transition-[opacity,transform,filter] duration-300 ease-[cubic-bezier(0.2,0,0,1)] ${completing ? "opacity-0 scale-[0.25] blur-[4px]" : "opacity-100 scale-100 blur-0"}`}
							/>
						</span>
					</button>
				</Tooltip>
			)}
		</div>
	);
}
