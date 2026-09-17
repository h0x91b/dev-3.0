import type { ReviewComment, ReviewDiffSide } from "../../shared/review";

/**
 * Before comments lived on the task record, the diff viewer kept them in
 * localStorage under this key, per task, for three days. This module reads that
 * shape once so an in-flight review is carried over, then deletes the key.
 */
const LEGACY_PREFIX = "dev3-inline-diff-review-v1";
const LEGACY_TTL_MS = 3 * 24 * 60 * 60 * 1000;

interface LegacyComment {
	id: string;
	body: string;
	createdAt: string;
	startLine: number;
	endLine: number;
	side: ReviewDiffSide;
	sentAt?: string;
}

interface LegacyStored {
	savedAt: number;
	comments: Record<string, { oldFile: Record<string, { data: { comments: LegacyComment[] } }>; newFile: Record<string, { data: { comments: LegacyComment[] } }> }>;
}

function legacyKey(taskId: string): string {
	return `${LEGACY_PREFIX}:${taskId}`;
}

/** Comments the old store still holds for the task, converted to the shared shape; empty when there is nothing (or it expired). */
export function readLegacyReview(taskId: string, now = Date.now()): ReviewComment[] {
	try {
		const raw = localStorage.getItem(legacyKey(taskId));
		if (!raw) return [];
		const parsed = JSON.parse(raw) as Partial<LegacyStored> | null;
		if (!parsed || typeof parsed.savedAt !== "number" || !parsed.comments || now - parsed.savedAt > LEGACY_TTL_MS) return [];
		const result: ReviewComment[] = [];
		for (const [fileId, fileData] of Object.entries(parsed.comments)) {
			for (const side of ["oldFile", "newFile"] as const) {
				for (const slot of Object.values(fileData?.[side] ?? {})) {
					for (const comment of slot?.data?.comments ?? []) {
						if (!comment?.id || !comment.body) continue;
						result.push({
							id: comment.id,
							body: comment.body,
							createdAt: comment.createdAt ?? new Date(parsed.savedAt).toISOString(),
							sentAt: comment.sentAt,
							// The diff file id IS its path (`git.ts` builds it that way).
							anchor: { kind: "diff-line", fileId, filePath: fileId, side, startLine: comment.startLine, endLine: comment.endLine },
						});
					}
				}
			}
		}
		return result;
	} catch {
		return [];
	}
}

export function dropLegacyReview(taskId: string): void {
	try {
		localStorage.removeItem(legacyKey(taskId));
	} catch {}
}

/** Remove every legacy review key — they are all either imported or expired by now. */
export function pruneLegacyReviews(now = Date.now()): void {
	try {
		const stale: string[] = [];
		for (let i = 0; i < localStorage.length; i++) {
			const key = localStorage.key(i);
			if (!key || !key.startsWith(`${LEGACY_PREFIX}:`)) continue;
			try {
				const parsed = JSON.parse(localStorage.getItem(key) ?? "null") as Partial<LegacyStored> | null;
				if (!parsed || typeof parsed.savedAt !== "number" || now - parsed.savedAt > LEGACY_TTL_MS) stale.push(key);
			} catch {
				stale.push(key);
			}
		}
		for (const key of stale) localStorage.removeItem(key);
	} catch {}
}
