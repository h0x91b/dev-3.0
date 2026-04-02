import type { Task, TaskStatus } from "../../shared/types";

interface VariantDotsProps {
	groupMembers: Task[];
	currentTaskId: string;
	statusColors: Record<TaskStatus, string>;
	size?: "xs" | "sm";
	testId?: string;
}

function VariantDots({
	groupMembers,
	currentTaskId,
	statusColors,
	size = "xs",
	testId,
}: VariantDotsProps) {
	if (groupMembers.length <= 1) return null;

	const dotClassName = size === "sm" ? "h-2 w-2" : "h-1.5 w-1.5";
	const gapClassName = size === "sm" ? "gap-1" : "gap-0.5";

	return (
		<span data-testid={testId} className={`inline-flex items-center ${gapClassName}`}>
			{groupMembers.map((task) => (
				<span
					key={task.id}
					className={`${dotClassName} rounded-full flex-shrink-0 ${
						task.id === currentTaskId ? "ring-1 ring-fg ring-offset-1 ring-offset-base" : ""
					}`}
					style={{ background: statusColors[task.status] }}
				/>
			))}
		</span>
	);
}

export default VariantDots;
