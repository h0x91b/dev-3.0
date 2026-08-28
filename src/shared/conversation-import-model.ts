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

/** One row of the import preview. The transcript path stays server-side. */
export interface ImportableConversationView {
	sessionId: string;
	title: string;
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
