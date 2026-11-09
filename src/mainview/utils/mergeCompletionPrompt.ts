const inFlightMergeCompletionPrompts = new Set<string>();

function promptKey(taskId: string, fingerprint: string | null | undefined): string {
	return `${taskId}:${fingerprint || "unknown"}`;
}

export async function runMergeCompletionPromptOnce<T>(
	taskId: string,
	fingerprint: string | null | undefined,
	prompt: () => Promise<T>,
): Promise<T | null> {
	const key = promptKey(taskId, fingerprint);
	if (inFlightMergeCompletionPrompts.has(key)) return null;

	inFlightMergeCompletionPrompts.add(key);
	try {
		return await prompt();
	} finally {
		inFlightMergeCompletionPrompts.delete(key);
	}
}

export function _resetMergeCompletionPromptInFlightForTests(): void {
	inFlightMergeCompletionPrompts.clear();
}
