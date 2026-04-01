import { useEffect, useState } from "react";
import type { Task } from "../../../shared/types";
import { api } from "../../rpc";

export function useTaskAllocatedPorts(task: Task): number[] {
	const [allocatedPorts, setAllocatedPorts] = useState<number[]>([]);

	useEffect(() => {
		if (!task.worktreePath) {
			setAllocatedPorts([]);
			return;
		}

		api.request.getPortAllocations({ taskId: task.id })
			.then(setAllocatedPorts)
			.catch(() => setAllocatedPorts([]));
	}, [task.id, task.worktreePath]);

	return allocatedPorts;
}
