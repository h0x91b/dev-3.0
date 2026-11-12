/** What a CLI reports about where it runs: its raw `$TMUX` and its `DEV3_TASK_ID`. */
export type SenderEvidence = { tmuxEnv?: string | null; envTaskId?: string | null };

export function senderEvidenceOf(params: Record<string, unknown>): SenderEvidence {
	return {
		tmuxEnv: typeof params.sourceTmux === "string" ? params.sourceTmux : null,
		envTaskId: typeof params.sourceEnvTaskId === "string" ? params.sourceEnvTaskId : null,
	};
}
