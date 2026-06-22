import { useState } from "react";
import type { Tip } from "../tips";
import type { TipState } from "../../shared/types";
import { SNOOZE_MS, ROTATION_INTERVAL_MS } from "../tips";
import { useT } from "../i18n";
import { api } from "../rpc";

interface TipCardProps {
	tip: Tip;
	tipState: TipState;
	/** Apply the TipState returned by the rotate/snooze write. */
	onChanged: (next: TipState) => void;
	/** Tighter padding for narrow carriers (e.g. the Active Tasks sidebar). */
	compact?: boolean;
}

function TipCard({ tip, tipState, onChanged, compact = false }: TipCardProps) {
	const t = useT();
	// Hovering the card pauses the rotation timer (and its progress bar).
	const [paused, setPaused] = useState(false);

	/** Mark the current tip seen and advance to the next one. */
	function rotate() {
		api.request.updateTipState({
			seen: { [tip.id]: Date.now() },
			rotationIndex: tipState.rotationIndex + 1,
		}).then(onChanged).catch(() => {});
	}

	function handleSnooze(e: React.MouseEvent) {
		e.stopPropagation();
		api.request.updateTipState({
			snoozedUntil: Date.now() + SNOOZE_MS,
		}).then(onChanged).catch(() => {});
	}

	function handleNext(e: React.MouseEvent) {
		e.stopPropagation();
		rotate();
	}

	return (
		<div
			onMouseEnter={() => setPaused(true)}
			onMouseLeave={() => setPaused(false)}
			className={`relative overflow-hidden select-none ${compact ? "p-2.5" : "p-3.5"} rounded-xl border border-dashed border-accent/25 bg-accent/[0.04] transition-all hover:border-accent/40 hover:bg-accent/[0.07]`}
		>
			{/* Snooze button (hide all tips for 4h) */}
			<button
				onClick={handleSnooze}
				className="absolute top-2.5 right-2.5 w-5 h-5 flex items-center justify-center rounded-md text-fg-muted hover:text-fg-3 hover:bg-fg/5 transition-all"
				title={t("tip.snooze")}
			>
				<svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
					<path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
				</svg>
			</button>

			{/* Badge */}
			<div className="flex items-center gap-1.5 mb-2">
				<span
					className="text-accent text-sm leading-none"
					style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}
				>
					{tip.icon}
				</span>
				<span className="text-[0.625rem] font-semibold text-accent uppercase tracking-wider">
					{t("tip.badge")}
				</span>
			</div>

			{/* Title */}
			<div className="text-fg text-sm leading-relaxed font-medium pr-5 mb-1">
				{t(tip.titleKey)}
			</div>

			{/* Body */}
			<div className="text-fg-3 text-xs leading-relaxed">
				{t(tip.bodyKey)}
			</div>

			{/* Next tip link */}
			<button
				onClick={handleNext}
				className="mt-2.5 text-[0.625rem] text-fg-muted hover:text-accent transition-colors"
			>
				{t("tip.next")} →
			</button>

			{/* Rotation progress bar — the animation IS the timer: when it ends we
			    rotate. Pauses on hover; restarts (key) on every tip change. */}
			<div className="mt-2.5 h-[3px] rounded-full bg-accent/10 overflow-hidden">
				<div
					key={`${tip.id}-${tipState.rotationIndex}`}
					data-testid="tip-progress"
					className="h-full bg-accent/40 origin-left"
					onAnimationEnd={(e) => {
						if (e.animationName === "tip-progress") rotate();
					}}
					style={{
						animationName: "tip-progress",
						animationDuration: `${ROTATION_INTERVAL_MS}ms`,
						animationTimingFunction: "linear",
						animationFillMode: "forwards",
						animationPlayState: paused ? "paused" : "running",
					}}
				/>
			</div>
		</div>
	);
}

export default TipCard;
