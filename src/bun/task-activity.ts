const activity = new Map<string, number>();
let policyRevision = 0;

export function recordAutoHibernatePolicyChange(): void {
	policyRevision++;
}

export function lastAutoHibernatePolicyChange(): number {
	return policyRevision;
}

export function recordTaskActivity(taskId: string, at = Date.now()): void {
	if (Number.isFinite(at) && at > 0) activity.set(taskId, Math.max(activity.get(taskId) ?? 0, at));
}

export function lastTaskActivity(taskId: string): number {
	return activity.get(taskId) ?? 0;
}

export function forgetTaskActivity(taskId: string): void {
	activity.delete(taskId);
}
