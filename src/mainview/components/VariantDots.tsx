import { useRef, useState } from "react";
import type { CodingAgent, Task, TaskStatus } from "../../shared/types";
import type { Route } from "../state";
import { useT } from "../i18n";
import { selectVariantDots } from "../utils/variantGroups";
import SiblingPopover from "./SiblingPopover";
import Tooltip from "./Tooltip";

interface VariantDotsProps {
	groupMembers: Task[];
	currentTaskId: string;
	statusColors: Record<TaskStatus, string>;
	agents: CodingAgent[];
	navigate: (route: Route) => void;
	projectId: string;
	onOpen?: () => void;
	size?: "xs" | "sm";
	testId?: string;
}

/**
 * The shared, bounded variant-group affordance used by cards and active-task
 * strips. The cluster is one button; the full group lives in SiblingPopover.
 */
function VariantDots({
	groupMembers,
	currentTaskId,
	statusColors,
	agents,
	navigate,
	projectId,
	onOpen,
	size = "xs",
	testId,
}: VariantDotsProps) {
	const t = useT();
	const anchorRef = useRef<HTMLButtonElement>(null);
	const [popoverOpen, setPopoverOpen] = useState(false);
	const dots = selectVariantDots(groupMembers, currentTaskId);

	if (dots.length === 0) return null;

	const dotClassName = size === "sm" ? "h-2 w-2" : "h-1.5 w-1.5";
	const gapClassName = size === "sm" ? "gap-1" : "gap-0.5";
	const siblingCount = Math.max(1, groupMembers.length - 1);

	return (
		<>
			<Tooltip content={t.plural("task.siblingsCount", siblingCount)} detail={t("ttip.task.siblings")}>
				<button
					ref={anchorRef}
					type="button"
					data-testid={testId}
					aria-label={t.plural("task.siblingsCount", siblingCount)}
					aria-haspopup="dialog"
					onClick={(event) => {
						event.stopPropagation();
						onOpen?.();
						setPopoverOpen((open) => !open);
					}}
					className={`inline-flex min-w-[2.25rem] items-center justify-start rounded-lg px-1.5 py-1 transition-colors hover:bg-fg/5 focus:outline-none focus-visible:ring-1 focus-visible:ring-accent ${gapClassName}`}
				>
					{dots.map((variant) => (
						<span
							key={variant.id}
							aria-hidden="true"
							data-testid={testId ? `${testId}-dot-${variant.id}` : undefined}
							className={`${dotClassName} flex-shrink-0 rounded-full ${variant.id === currentTaskId ? "ring-1 ring-fg ring-offset-1 ring-offset-base" : ""}`}
							style={{ background: statusColors[variant.status] }}
						/>
					))}
				</button>
			</Tooltip>
			{popoverOpen && anchorRef.current && (
				<SiblingPopover
					variants={groupMembers}
					currentTaskId={currentTaskId}
					agents={agents}
					navigate={navigate}
					onClose={() => setPopoverOpen(false)}
					anchorEl={anchorRef.current}
					projectId={projectId}
				/>
			)}
		</>
	);
}

export default VariantDots;
