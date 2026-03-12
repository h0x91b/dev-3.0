import type { TaskStatus } from "../../shared/types";
import { useStatusColors } from "../hooks/useStatusColors";
import { PIPELINE_STAGES, getStageStates } from "./StatusPipeline";

interface MiniPipelineProps {
	status: TaskStatus;
}

/**
 * Compact horizontal pipeline dots showing task progress.
 * Each dot represents a main pipeline stage. Done = colored, current = colored+ring,
 * future = dim. Side-branch statuses show a modifier icon on the current dot.
 */
export default function MiniPipeline({ status }: MiniPipelineProps) {
	const statusColors = useStatusColors();
	const states = getStageStates(status);
	const isCancelled = status === "cancelled";
	const cancelledColor = statusColors["cancelled"];

	return (
		<div className="flex items-center gap-0.5" title={`Pipeline: ${status}`}>
			{PIPELINE_STAGES.map((stage, i) => {
				const state = states[i];
				const color = statusColors[stage];
				const isCurrent = state === "current";

				return (
					<div key={stage} className="flex items-center">
						{/* Connector line between dots */}
						{i > 0 && (
							<div
								className="h-[1.5px] w-1.5 flex-shrink-0"
								style={{
									background: isCancelled
										? cancelledColor
										: state === "future"
											? "var(--color-fg-muted, #555)"
											: color,
									opacity: isCancelled ? 0.2 : state === "future" ? 0.3 : 0.6,
								}}
							/>
						)}
						{/* Dot */}
						<div
							className="relative flex-shrink-0"
							style={{ width: isCurrent && !isCancelled ? 7 : 5, height: isCurrent && !isCancelled ? 7 : 5 }}
						>
							<div
								className="absolute inset-0 rounded-full"
								style={{
									background: isCancelled
										? cancelledColor
										: state === "future"
											? "var(--color-fg-muted, #555)"
											: isCurrent ? statusColors[status] : color,
									opacity: isCancelled ? 0.25 : state === "future" ? 0.25 : state === "done" ? 0.5 : 1,
									boxShadow: isCurrent && !isCancelled
										? `0 0 4px ${statusColors[status]}80`
										: undefined,
								}}
							/>
						</div>
					</div>
				);
			})}
		</div>
	);
}
