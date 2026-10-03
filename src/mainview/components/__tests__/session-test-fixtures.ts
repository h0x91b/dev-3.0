import type { ClaudeSessionStats } from "../../../shared/session-stats";

export const NOW = 1_790_866_000_000;

export function session(taskId: string, overrides: Partial<ClaudeSessionStats> = {}): ClaudeSessionStats {
	return {
		taskId,
		taskTitle: `Task ${taskId}`,
		taskSeq: 1,
		projectName: "dev-3.0",
		projectId: "p1",
		awaitingUser: false,
		capturedAt: NOW - 30_000,
		model: "Opus 5.5",
		effort: "high",
		sessionName: null,
		thinking: true,
		contextPercent: 10,
		contextWindowSize: 1_000_000,
		totalTokens: 82_774,
		cacheReadTokens: 79_694,
		cacheWriteTokens: 3070,
		turnInputTokens: 2,
		turnOutputTokens: 657,
		cache: null,
		costUsd: null,
		durationMs: 62_816,
		apiDurationMs: 40_044,
		linesAdded: 3,
		linesRemoved: 1,
		...overrides,
	};
}

export const warmFor = (ms: number, ttl = "5m") => ({ warm: true, ttl, expiresAt: NOW + ms, hitRatio: 0.9, misses: 0 });
