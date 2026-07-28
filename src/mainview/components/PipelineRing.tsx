import type { TaskStatus } from "../../shared/types";
import { useStatusColors } from "../hooks/useStatusColors";
import { useT } from "../i18n";
import Tooltip from "./Tooltip";
import { PIPELINE_STAGES, getPipelineIndex, isSideBranch } from "./StatusPipeline";

/** The pipeline's "you are done" glyph, shared by every quick-complete affordance. */
export function CompleteCheckIcon({ className }: { className?: string }) {
	return (
		<svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round">
			<path d="M20 6 9 17l-5-5" />
		</svg>
	);
}

interface PipelineRingProps {
	status: TaskStatus;
	/** "touch" bumps the ring to a legible size inside ≥44px rows. */
	size?: "default" | "touch";
	/** Off where the stage position is already spelled out next to the ring. */
	tooltip?: boolean;
}

const RING_PX = { default: 18, touch: 22 } as const;

/**
 * Compact conic progress ring replacing the seven-dot mini pipeline: the arc is
 * the share of the pipeline already walked, the glyph inside is the stage index
 * (× for the cancelled side-branch). Conic gradients and per-status hex cannot
 * be expressed as tokens, so this component styles inline (STATUS_COLORS is the
 * documented exception).
 */
export default function PipelineRing({ status, size = "default", tooltip = true }: PipelineRingProps) {
	const t = useT();
	const statusColors = useStatusColors();
	const index = getPipelineIndex(status);
	const stage = index + 1;
	const total = PIPELINE_STAGES.length;
	const sideBranch = isSideBranch(status);
	const color = statusColors[status];
	const px = RING_PX[size];
	const hole = px / 2 - 2.6;
	const label = t("pipeline.stageOf", { current: String(stage), total: String(total) });

	return (
		<Tooltip content={label} disabled={!tooltip}>
		<div
			role="img"
			aria-label={label}
			className="relative flex-shrink-0 grid place-items-center"
			style={{ width: px, height: px }}
		>
			<div
				className="absolute inset-0 rounded-full"
				style={{
					background: `conic-gradient(${color} ${(stage / total) * 100}%, rgb(var(--text-muted) / 0.35) 0)`,
					WebkitMaskImage: `radial-gradient(circle, transparent ${hole}px, #000 ${hole + 0.5}px)`,
					maskImage: `radial-gradient(circle, transparent ${hole}px, #000 ${hole + 0.5}px)`,
					opacity: sideBranch ? 0.55 : 1,
				}}
			/>
			<span
				className="relative font-bold tabular-nums leading-none text-fg"
				style={{ fontSize: size === "touch" ? 11 : 9 }}
			>
				{sideBranch ? "×" : stage}
			</span>
		</div>
		</Tooltip>
	);
}
