/**
 * An approval temporarily moves a task to user-questions. Remember which active lane that
 * Codex/omp/agy session came from, so PostToolUse can restore a review agent to review-by-ai
 * instead of misclassifying it as the primary agent. Keyed `<taskId>:<sessionId>`, in memory only.
 */
const APPROVAL_RESUME_TTL_MS = 24 * 60 * 60 * 1000;

type ResumeStatus = "in-progress" | "review-by-ai";

const resumeStatuses = new Map<string, { status: ResumeStatus; expiresAt: number }>();

export function rememberResumeStatus(key: string, status: ResumeStatus): void {
	resumeStatuses.set(key, { status, expiresAt: Date.now() + APPROVAL_RESUME_TTL_MS });
}

export function getApprovalResumeStatus(key: string | null): ResumeStatus | undefined {
	if (!key) return undefined;
	const entry = resumeStatuses.get(key);
	if (!entry) return undefined;
	if (entry.expiresAt <= Date.now()) {
		resumeStatuses.delete(key);
		return undefined;
	}
	return entry.status;
}

export function forgetApprovalResumeStatus(key: string): void {
	resumeStatuses.delete(key);
}

/** Every session of a task: its agent is gone, so no remembered lane can still be right. */
export function forgetTaskApprovalResumeStatuses(taskId: string): void {
	const prefix = `${taskId}:`;
	for (const key of [...resumeStatuses.keys()]) {
		if (key.startsWith(prefix)) resumeStatuses.delete(key);
	}
}
