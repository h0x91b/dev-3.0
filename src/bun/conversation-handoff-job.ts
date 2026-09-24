import type { HandoffPreview } from "../shared/conversation-handoff-model";
import type { ParsedConversation } from "../shared/conversation-model";
import { renderHandoffFile, type RenderTarget } from "../shared/conversation-render";
import { newestWorktreeConversation, type TranscriptFingerprint } from "./conversation-parse";

/**
 * The CPU- and memory-heavy half of a handoff: find the worktree's newest
 * transcript, parse it whole, and either summarise it or render the retelling.
 *
 * Pure synchronous filesystem work with a structured-cloneable result, so it runs
 * unchanged inside the handoff worker (`workers/conversation-handoff-worker.ts`)
 * and inline as the fallback. Nothing here may touch the host's RPC or PTY state.
 */

export type HandoffJob =
	| { kind: "preview"; worktreePath: string; home: string; known?: TranscriptFingerprint | null }
	| { kind: "render"; worktreePath: string; home: string; target: RenderTarget };

export type HandoffJobResult =
	| { kind: "none" }
	| { kind: "unchanged" }
	| { kind: "preview"; preview: HandoffPreview; fingerprint: TranscriptFingerprint }
	| { kind: "render"; preview: HandoffPreview; text: string };

function previewOf(conversation: ParsedConversation): HandoffPreview {
	return {
		source: conversation.source,
		sessionId: conversation.sessionId,
		turns: conversation.stats.turns,
		toolCalls: conversation.stats.toolCalls,
		fidelity: conversation.fidelity.level,
	};
}

function sameFingerprint(a: TranscriptFingerprint, b: TranscriptFingerprint): boolean {
	return a.path === b.path && a.size === b.size && a.mtimeMs === b.mtimeMs;
}

export function executeHandoffJob(job: HandoffJob): HandoffJobResult {
	const known = job.kind === "preview" ? job.known : null;
	const newest = newestWorktreeConversation(job.worktreePath, {
		home: job.home,
		unchanged: known ? (fingerprint) => sameFingerprint(fingerprint, known) : undefined,
	});
	if (newest === "unchanged") return { kind: "unchanged" };
	if (!newest) return { kind: "none" };

	const preview = previewOf(newest.conversation);
	if (job.kind === "preview") return { kind: "preview", preview, fingerprint: newest.fingerprint };
	return { kind: "render", preview, text: renderHandoffFile(newest.conversation, { target: job.target }) };
}
