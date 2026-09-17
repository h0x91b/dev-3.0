import type { ConversationSource } from "./conversation-model";
import type { Task } from "./types";

/**
 * The vocabulary of the conversation import, shared by the RPC schema, the
 * backend and the preview screen. I/O-free on purpose: `src/shared` is imported
 * by the renderer, and discovery itself lives in `src/bun/conversation-import.ts`.
 */

/** A conversation whose last activity is inside this window can still be picked up. */
export const RECENT_ACTIVITY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** The label every imported task carries. */
export const IMPORTED_LABEL_NAME = "imported";

/** The column an imported conversation lands in, decided once from its age. */
export type ImportTargetStatus = "user-questions" | "completed";

/** The label each agent CLI is known by on an import row. */
export const CONVERSATION_SOURCE_LABELS: Record<ConversationSource, string> = {
	claude: "Claude Code",
	codex: "Codex",
};

/** One row of the import preview. The transcript path stays server-side. */
export interface ImportableConversationView {
	/** Which agent wrote it — shown, because the card says which CLI picks it up. */
	source: ConversationSource;
	sessionId: string;
	title: string;
	/**
	 * The agent never named this session, so the title is the first thing the user
	 * asked for. Always true for Codex, which writes no titles at all, and true for
	 * a Claude session that carries no `ai-title` record.
	 */
	titledFromRequest: boolean;
	/** Where it ran — worth showing when it is a subdirectory of the project. */
	workingDir: string;
	lastActivityMs: number;
	turns: number;
	targetStatus: ImportTargetStatus;
}

export interface ImportConversationsResult {
	imported: number;
	tasks: Task[];
	/** Human-readable trouble, one line each, for the caller to surface. */
	problems: { title: string; error: string }[];
}
