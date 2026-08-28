import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { resolveUserHome } from "../shared/user-home";
import { claudeEncodePath, claudeProjectsDir } from "../shared/conversation-search-core";
import { RECENT_ACTIVITY_WINDOW_MS, type ImportTargetStatus } from "../shared/conversation-import-model";
import { claudeConfigDirs } from "./agent-store-roots";

/**
 * Finding the Claude Code conversations that ran in a project's own directory
 * and belong to no dev3 task — the ones a developer accumulated before dev3
 * existed, which the board would otherwise never show.
 *
 * Two rules do all the work here:
 *
 *  - **Attachment is an invariant, not a filter.** A conversation belongs to the
 *    one project whose path CONTAINS its working directory, on a path boundary.
 *    Anything else is not importable — never guessed at, never matched by remote.
 *  - **The working directory comes from the store directory name**, because
 *    records may omit `cwd` entirely. The candidate project path is encoded
 *    FORWARD and compared; the encoding maps both `/` and `.` to `-`, so a store
 *    name has no unique inverse and must never be decoded backwards.
 *
 * Every dev3 worktree lives under `~/.dev3.0/`, which no project may contain, so
 * dev3's own tasks and ops sessions are excluded by construction. The explicit
 * check below is belt-and-braces on top of that.
 */

/** What a transcript turned out to be. The classes are mutually exclusive. */
export type TranscriptClass = "main" | "subagent" | "teammate" | "untitled";

export interface ClassifiedTranscript {
	kind: TranscriptClass;
	sessionId: string | null;
	/** Claude's own title for the conversation (`ai-title` record). */
	title: string | null;
	cwd: string | null;
	gitBranch: string | null;
	/** User messages that open a turn — what the reader means by "turns". */
	turns: number;
}

/**
 * Classify one transcript body.
 *
 * The whole file is scanned rather than sniffed from its first record: across
 * 1200 files that first record was a `user` message 77% of the time, a `mode`
 * record 20%, and six other types made up the rest — it says nothing about what
 * the session was. Subagent and teammate runs bail out the moment they are
 * recognised, so the common case (77% of files are subagent runs) is cheap.
 */
export function classifyClaudeTranscript(body: string): ClassifiedTranscript {
	const result: ClassifiedTranscript = { kind: "untitled", sessionId: null, title: null, cwd: null, gitBranch: null, turns: 0 };

	for (const line of body.split("\n")) {
		if (!line.trim()) continue;
		let record: Record<string, unknown>;
		try {
			record = JSON.parse(line) as Record<string, unknown>;
		} catch {
			continue;
		}

		// A file holding one sidechain record is entirely sidechain (verified: 231
		// of 231 in a 300-file sample), so the first one settles it.
		if (record.isSidechain === true) return { ...result, kind: "subagent" };
		if (record.type === "agent-setting") return { ...result, kind: "teammate" };

		result.sessionId ??= stringField(record, "sessionId") ?? stringField(record, "session_id");
		result.cwd ??= stringField(record, "cwd");
		result.gitBranch ??= stringField(record, "gitBranch");
		if (record.type === "ai-title") result.title ??= stringField(record, "aiTitle");
		if (record.type === "user" && record.isCompactSummary !== true && hasUserProse(record)) result.turns++;
	}

	return { ...result, kind: result.title ? "main" : "untitled" };
}

function stringField(record: Record<string, unknown>, key: string): string | null {
	const value = record[key];
	return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Does this `user` record open a turn? Only prose does: a record whose blocks are
 * all `tool_result` is the harness answering the agent, not the human speaking.
 * Same rule the turn assembler uses, so the count matches the parsed conversation.
 */
function hasUserProse(record: Record<string, unknown>): boolean {
	const message = record.message as Record<string, unknown> | undefined;
	const content = message?.content;
	if (typeof content === "string") return content.trim().length > 0;
	if (!Array.isArray(content)) return false;
	return content.some((block) => {
		if (!block || typeof block !== "object") return false;
		const b = block as Record<string, unknown>;
		return b.type === "text" && typeof b.text === "string" && b.text.trim().length > 0;
	});
}

/** One conversation that could become a task. */
export interface ImportableConversation {
	sessionId: string;
	title: string;
	/** Where it ran. Always inside the project, always still on disk. */
	workingDir: string;
	transcriptPath: string;
	gitBranch: string | null;
	lastActivityMs: number;
	turns: number;
	/** The column it would land in — decided once, here, from its age. */
	targetStatus: ImportTargetStatus;
}

export interface ScanOptions {
	projectPath: string;
	/** Session ids already imported — never offered twice. */
	importedSessionIds?: Iterable<string>;
	home?: string;
	nowMs?: number;
}

/**
 * Every importable conversation for one project, newest first.
 *
 * Only store directories whose name is the project's own encoded path (or a
 * subdirectory of it) are opened, so this costs a few `readdir`s plus a parse of
 * the transcripts that actually belong to the project — never a walk of the
 * thousands of worktree stores next to them.
 */
export function scanImportableConversations(options: ScanOptions): ImportableConversation[] {
	const home = options.home ?? resolveUserHome();
	const nowMs = options.nowMs ?? Date.now();
	const already = new Set(options.importedSessionIds ?? []);
	const dev3Prefix = `${home}/.dev3.0`;
	const encodedProject = claudeEncodePath(options.projectPath);

	const found: ImportableConversation[] = [];
	const seenSessions = new Set<string>();

	for (const storeRoot of claudeConfigDirs(home).map(claudeProjectsDir)) {
		for (const storeName of subdirs(storeRoot)) {
			// Forward-encoded boundary match: `<project>` itself, or something under
			// it. `…-scratch` is not a boundary, so a sibling repo never matches.
			if (storeName !== encodedProject && !storeName.startsWith(`${encodedProject}-`)) continue;
			for (const file of jsonlFiles(`${storeRoot}/${storeName}`)) {
				const body = readFileSafe(file);
				if (body == null) continue;
				const classified = classifyClaudeTranscript(body);
				if (classified.kind !== "main" || !classified.sessionId || !classified.title) continue;
				if (already.has(classified.sessionId) || seenSessions.has(classified.sessionId)) continue;

				const workingDir = resolveWorkingDir(classified.cwd, storeName, encodedProject, options.projectPath);
				if (!workingDir) continue;
				// A working directory dev3 owns is never project work, and one that is
				// gone is not somewhere work can be picked up again.
				if (workingDir === dev3Prefix || workingDir.startsWith(`${dev3Prefix}/`)) continue;
				if (!existsSync(workingDir)) continue;

				const lastActivityMs = mtimeMsOf(file);
				if (lastActivityMs == null) continue;
				seenSessions.add(classified.sessionId);
				found.push({
					sessionId: classified.sessionId,
					title: classified.title,
					workingDir,
					transcriptPath: file,
					gitBranch: classified.gitBranch,
					lastActivityMs,
					turns: classified.turns,
					targetStatus: nowMs - lastActivityMs <= RECENT_ACTIVITY_WINDOW_MS ? "user-questions" : "completed",
				});
			}
		}
	}

	return found.sort((a, b) => b.lastActivityMs - a.lastActivityMs);
}

/**
 * The working directory this conversation ran in, or null when it cannot be
 * established inside the project.
 *
 * The store name settles the exact-match case with no ambiguity at all. Deeper
 * directories need the record's own `cwd`, because encoding is lossy — and that
 * `cwd` is then checked against the project on a real path boundary, which is
 * what stops `/p/dev-3.0-scratch` from being read as a child of `/p/dev-3.0`.
 */
function resolveWorkingDir(
	cwd: string | null,
	storeName: string,
	encodedProject: string,
	projectPath: string,
): string | null {
	if (storeName === encodedProject) return projectPath;
	if (!cwd) return null;
	if (cwd === projectPath || cwd.startsWith(`${projectPath}/`)) return cwd;
	return null;
}

function subdirs(dir: string): string[] {
	try {
		return readdirSync(dir, { withFileTypes: true })
			.filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
			.map((entry) => entry.name);
	} catch {
		return [];
	}
}

function jsonlFiles(dir: string): string[] {
	try {
		return readdirSync(dir).filter((name) => name.endsWith(".jsonl")).map((name) => `${dir}/${name}`);
	} catch {
		return [];
	}
}

function readFileSafe(path: string): string | null {
	try {
		return readFileSync(path, "utf-8");
	} catch {
		return null;
	}
}

function mtimeMsOf(path: string): number | null {
	try {
		return statSync(path).mtimeMs;
	} catch {
		return null;
	}
}
