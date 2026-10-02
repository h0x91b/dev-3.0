import { useEffect, useState } from "react";
import { subscribePaneState } from "../pane-state-bus";
import type { TaskPaneState } from "../../shared/task-panes";

/**
 * The latest pane state the bus delivered for `taskId`, or null until one arrives.
 *
 * The state is held together with the task it belongs to: the inspector bar stays
 * mounted across a task switch, and a bare `useState` kept showing the previous
 * task's panes — a Close pane button on a single-pane task — until the next read.
 */
export function useTaskPaneState(taskId: string): TaskPaneState | null {
	const [held, setHeld] = useState<{ taskId: string; state: TaskPaneState } | null>(null);
	useEffect(() => subscribePaneState(taskId, (state) => setHeld({ taskId, state })), [taskId]);
	return held?.taskId === taskId ? held.state : null;
}
