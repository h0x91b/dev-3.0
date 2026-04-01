import type { TaskDiffMode } from "../../shared/types";
import { useCallback, useEffect, useState } from "react";

export interface TaskInlineDiffRequest {
	mode: TaskDiffMode;
	compareRef?: string;
	compareLabel?: string;
	focusFile?: string;
}

export function useTaskInlineDiffState(taskId?: string) {
	const [request, setRequest] = useState<TaskInlineDiffRequest | null>(null);

	useEffect(() => {
		setRequest(null);
	}, [taskId]);

	const open = useCallback((nextRequest: TaskInlineDiffRequest) => {
		setRequest(nextRequest);
	}, []);

	const close = useCallback(() => {
		setRequest(null);
	}, []);

	return {
		request,
		isOpen: request !== null,
		open,
		close,
	};
}
