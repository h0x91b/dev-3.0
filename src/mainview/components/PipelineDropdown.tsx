import type { TaskStatus } from "../../shared/types";
import type { CustomColumn, Project } from "../../shared/types";
import { getAllowedTransitions } from "../../shared/types";
import { useStatusColors } from "../hooks/useStatusColors";
import { useT } from "../i18n";
import { getStatusLabel } from "../utils/statusLabel";
import { PIPELINE_STAGES, getStageStates, isSideBranch, type StageState } from "./StatusPipeline";

interface PipelineDropdownProps {
	currentStatus: TaskStatus;
	onMove: (status: TaskStatus) => void;
	onMoveToCustomColumn?: (columnId: string) => void;
	onDelete?: () => void;
	customColumns?: CustomColumn[];
	currentCustomColumnId?: string | null;
	project?: Pick<Project, "customStatusLabels"> | null;
	/** "touch" bumps rows to ≥44px targets for the narrow-viewport bottom sheet. */
	size?: "default" | "touch";
	/** Hide the internal "Move to" header (the hosting sheet already shows one). */
	hideHeader?: boolean;
}

/** Side-branch statuses that aren't in PIPELINE_STAGES but still need to be selectable */
const SIDE_STATUSES: TaskStatus[] = ["cancelled"];

export default function PipelineDropdown({
	currentStatus,
	onMove,
	onMoveToCustomColumn,
	onDelete,
	customColumns,
	currentCustomColumnId,
	project,
	size = "default",
	hideHeader = false,
}: PipelineDropdownProps) {
	const t = useT();
	const statusColors = useStatusColors();
	const states = getStageStates(currentStatus);
	const allowed = getAllowedTransitions(currentStatus);
	const isCancelled = currentStatus === "cancelled";
	const touch = size === "touch";
	const sectionPad = touch ? "px-1" : "px-3";
	const rowText = touch ? "text-base" : "text-sm";
	const rowPad = touch ? "min-h-[2.75rem] py-2.5 px-2" : "py-1.5 px-1.5";

	return (
		<div onClick={(e) => e.stopPropagation()}>
			{!hideHeader && (
				<div className="px-3 py-2 text-xs text-fg-3 uppercase tracking-wider font-semibold">
					{t("task.moveTo")}
				</div>
			)}

			{/* Main pipeline stages */}
			<div className={`${sectionPad} pb-1`}>
				{PIPELINE_STAGES.map((stage, i) => {
					const state = states[i];
					const isCurrentStage = state === "current" && !isSideBranch(currentStatus);
					const canTransition = allowed.includes(stage) && !isCurrentStage;
					const color = statusColors[stage];
					const isLast = i === PIPELINE_STAGES.length - 1;

					return (
						<div key={stage} className="flex items-stretch">
							{/* Pipeline track (dots + line) */}
							<div className={`flex flex-col items-center flex-shrink-0 ${touch ? "w-6" : "w-5"}`}>
								{/* Dot */}
								<div className={`flex items-center justify-center ${touch ? "h-[2.75rem]" : "h-[1.875rem]"}`}>
									<PipelineDot
										state={state}
										color={color}
										activeColor={statusColors[currentStatus]}
										isSideBranch={false}
										touch={touch}
									/>
								</div>
								{/* Connector line */}
								{!isLast && (
									<div
										className="w-[2px] flex-1 min-h-[2px]"
										style={{
											background: state === "future" || states[i + 1] === "future"
												? "var(--color-fg-muted, #555)"
												: color,
											opacity: state === "future" || states[i + 1] === "future" ? 0.2 : 0.35,
										}}
									/>
								)}
							</div>

							{/* Label */}
							<button
								onClick={canTransition ? () => onMove(stage) : undefined}
								disabled={!canTransition}
								className={`flex-1 text-left ${touch ? "min-h-[2.75rem] py-2.5 pl-2" : "py-1.5 pl-1.5"} pr-3 ${rowText} rounded-md transition-colors ${
									isCurrentStage
										? "text-fg font-semibold cursor-default"
										: canTransition
											? "text-fg-2 hover:bg-elevated-hover hover:text-fg cursor-pointer"
											: "text-fg-muted/40 cursor-default"
								}`}
							>
								{getStatusLabel(stage, t, project)}
								{isCurrentStage && (
									<span className="ml-1.5 text-[0.625rem] text-fg-3 font-normal">
										{"\u2190"} {t("pipeline.current")}
									</span>
								)}
							</button>
						</div>
					);
				})}
			</div>

			{/* Side-branch statuses */}
			{SIDE_STATUSES.some((s) => allowed.includes(s) || currentStatus === s) && (
				<>
					<div className="border-t border-edge-active mx-3 my-1" />
					<div className={`${sectionPad} pb-1`}>
						{SIDE_STATUSES.map((stage) => {
							const isCurrentSide = currentStatus === stage;
							const canTransition = allowed.includes(stage) && !isCurrentSide;
							const color = statusColors[stage];

							if (!canTransition && !isCurrentSide) return null;

							return (
								<button
									key={stage}
									onClick={canTransition ? () => onMove(stage) : undefined}
									disabled={!canTransition}
									className={`w-full text-left flex items-center gap-2.5 ${rowPad} ${rowText} rounded-md transition-colors ${
										isCurrentSide
											? "text-fg font-semibold cursor-default"
											: canTransition
												? "text-fg-2 hover:bg-elevated-hover hover:text-fg cursor-pointer"
												: "text-fg-muted/40 cursor-default"
									}`}
								>
									<div
										className={`rounded-full flex-shrink-0 ${touch ? "w-3 h-3" : "w-2.5 h-2.5"}`}
										style={{
											background: color,
											opacity: isCurrentSide ? 1 : 0.6,
											boxShadow: isCurrentSide ? `0 0 6px ${color}60` : undefined,
										}}
									/>
									{getStatusLabel(stage, t, project)}
									{isCurrentSide && (
										<span className="ml-1 text-[0.625rem] text-fg-3 font-normal">
											{"\u2190"} {t("pipeline.current")}
										</span>
									)}
								</button>
							);
						})}
					</div>
				</>
			)}

			{/* Custom columns */}
			{customColumns && customColumns.length > 0 && (
				<>
					<div className="border-t border-edge-active mx-3 my-1" />
					<div className={`${sectionPad} pb-1`}>
						{customColumns.map((col) => {
							const isCurrent = col.id === currentCustomColumnId;
							return (
								<button
									key={col.id}
									onClick={!isCurrent ? () => onMoveToCustomColumn?.(col.id) : undefined}
									disabled={isCurrent}
									className={`w-full text-left flex items-center gap-2.5 ${rowPad} ${rowText} rounded-md transition-colors ${
										isCurrent
											? "text-fg font-semibold cursor-default"
											: "text-fg-2 hover:bg-elevated-hover hover:text-fg cursor-pointer"
									}`}
								>
									<div
										className={`rounded-full flex-shrink-0 ${touch ? "w-3 h-3" : "w-2.5 h-2.5"}`}
										style={{
											background: col.color,
											boxShadow: isCurrent ? `0 0 6px ${col.color}60` : undefined,
										}}
									/>
									{col.name}
									{isCurrent && (
										<span className="ml-1 text-[0.625rem] text-fg-3 font-normal">
											{"\u2190"} {t("pipeline.current")}
										</span>
									)}
								</button>
							);
						})}
					</div>
				</>
			)}

			{/* Delete button for cancelled tasks */}
			{isCancelled && onDelete && (
				<div className="border-t border-edge-active mx-3 mt-1 pt-1 pb-1">
					<button
						onClick={onDelete}
						className={`w-full text-left ${touch ? "min-h-[2.75rem] px-2 py-2.5" : "px-1.5 py-2"} ${rowText} text-danger hover:bg-danger/10 flex items-center gap-2.5 rounded-md transition-colors`}
					>
						<svg
							className={`flex-shrink-0 ${touch ? "w-5 h-5" : "w-4 h-4"}`}
							fill="none"
							stroke="currentColor"
							viewBox="0 0 24 24"
						>
							<path
								strokeLinecap="round"
								strokeLinejoin="round"
								strokeWidth={2}
								d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
							/>
						</svg>
						{t("task.delete")}
					</button>
				</div>
			)}
		</div>
	);
}

function PipelineDot({
	state,
	color,
	activeColor,
	isSideBranch: _isSide,
	touch = false,
}: {
	state: StageState;
	color: string;
	activeColor: string;
	isSideBranch: boolean;
	touch?: boolean;
}) {
	const bump = touch ? 2 : 0;
	const size = (state === "current" ? 10 : 8) + bump;
	const dotSize = (state === "current" ? 10 : 6) + bump;

	return (
		<div
			className="relative flex items-center justify-center"
			style={{ width: size, height: size }}
		>
			{/* Glow ring for current */}
			{state === "current" && (
				<div
					className="absolute inset-[-2px] rounded-full"
					style={{
						background: `${activeColor}20`,
						boxShadow: `0 0 8px ${activeColor}40`,
					}}
				/>
			)}
			{/* Main dot */}
			<div
				className="rounded-full relative z-10"
				style={{
					width: dotSize,
					height: dotSize,
					background: state === "current" ? activeColor : color,
					opacity: state === "future" ? 0.25 : state === "done" ? 0.5 : 1,
					boxShadow: state === "current" ? `0 0 6px ${activeColor}80` : undefined,
				}}
			/>
		</div>
	);
}
