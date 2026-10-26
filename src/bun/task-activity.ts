const activity = new Map<string, number>();
const viewers = new Map<string, { taskId: string; expiresAt: number }>();
let policyChangedAt = 0;

export function reportTaskViewer(clientId: string, taskId: string | null, focused: boolean, now = Date.now()): void {
	viewers.delete(clientId);
	if (!taskId) return;
	recordTaskActivity(taskId, now);
	if (focused) viewers.set(clientId, { taskId, expiresAt: now + 30_000 });
}

export function isTaskBeingViewed(taskId: string, now = Date.now()): boolean {
	for (const [client, viewer] of viewers) {
		if (viewer.expiresAt <= now) viewers.delete(client);
		else if (viewer.taskId === taskId) return true;
	}
	return false;
}

export function recordAutoHibernatePolicyChange(): void {
	policyChangedAt = Date.now();
}

export function lastAutoHibernatePolicyChange(): number {
	return policyChangedAt;
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
