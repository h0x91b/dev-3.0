import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync, type Dirent } from "node:fs";
import { toPosixSeparators } from "../shared/project-storage-key";
import { resolveUserHome } from "../shared/user-home";
import { resolveDev3Home } from "../shared/dev3-home";
import { claudeEncodePath, claudeProjectsDir } from "../shared/conversation-search-core";
import { RECENT_ACTIVITY_WINDOW_MS, type ImportTargetStatus } from "../shared/conversation-import-model";
import type { ConversationSource } from "../shared/conversation-model";
import { isCodexInjectedUserText } from "../shared/conversation-parsers/codex";
import { claudeConfigDirs, codexSessionRoots } from "./agent-store-roots";

/**
 * Finding the Claude Code and Codex conversations that ran in a project's own
 * directory and belong to no dev3 task — the ones a developer accumulated before
 * dev3 existed, which the board would otherwise never show.
 *
 * Two rules do all the work here:
 *
 *  - **Attachment is an invariant, not a filter.** A conversation belongs to the
 *    one project whose path CONTAINS its working directory, on a path boundary.
 *    Anything else is not importable — never guessed at, never matched by remote.
 *  - **The working directory comes from the store directory name**, because
 *    Claude records may omit `cwd` entirely. The candidate project path is encoded
 *    FORWARD and compared; the encoding maps both `/` and `.` to `-`, so a store
 *    name has no unique inverse and must never be decoded backwards.
 *
 * Every dev3 worktree lives under `~/.dev3.0/`, which no project may contain, so
 * dev3's own tasks and ops sessions are excluded by construction. The explicit
 * check below is belt-and-braces on top of that.
 *
 * The two stores are shaped nothing alike and cost different things to search.
 * Claude's is keyed by encoded working directory, so the project's own name picks
 * out a handful of directories and everything else stays unopened. Codex's is a
 * flat date tree — `<Y>/<M>/<D>/rollout-*.jsonl` with the working directory only
 * inside the file — so every rollout has to be looked at. `codexHeader` reads a
 * bounded head of each one for that reason: 1.4 GB of transcripts on this machine
 * costs ~836 short reads instead of 1.4 GB, and only the files that turn out to
 * belong to the project are then read whole.
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

/**
 * The head of a Codex rollout: its `session_meta` line, and nothing else.
 *
 * The header is one JSON line and the biggest one on this machine is 45 KB, so a
 * 256 KB budget reads it whole with room to spare. A file whose first line does
 * not fit is reported as a miss rather than half-parsed — see `codexHeader`.
 */
const CODEX_HEADER_BUDGET_BYTES = 256 * 1024;

/** The `session_meta` fields the scan needs, or null when this is not a rollout. */
export function codexHeaderFrom(head: string): { sessionId: string; cwd: string | null } | null {
	const newline = head.indexOf("\n");
	// No newline inside the budget: the header is bigger than any we have seen and
	// what we hold is a fragment. Guessing from a fragment is worse than skipping.
	if (newline < 0) return null;
	let record: Record<string, unknown>;
	try {
		record = JSON.parse(head.slice(0, newline)) as Record<string, unknown>;
	} catch {
		return null;
	}
	if (record.type !== "session_meta") return null;
	const payload = record.payload as Record<string, unknown> | undefined;
	if (!payload) return null;
	const sessionId = stringField(payload, "id") ?? stringField(payload, "session_id");
	return sessionId ? { sessionId, cwd: stringField(payload, "cwd") } : null;
}

/** Read at most `CODEX_HEADER_BUDGET_BYTES` from the front of a file. */
function readHead(path: string): string | null {
	let fd: number | null = null;
	try {
		fd = openSync(path, "r");
		const buffer = Buffer.allocUnsafe(CODEX_HEADER_BUDGET_BYTES);
		const read = readSync(fd, buffer, 0, CODEX_HEADER_BUDGET_BYTES, 0);
		return buffer.subarray(0, read).toString("utf-8");
	} catch {
		return null;
	} finally {
		if (fd != null) try { closeSync(fd); } catch { /* already gone */ }
	}
}

/** What a Codex rollout turned out to be. Codex writes no title of its own. */
export interface ClassifiedRollout {
	sessionId: string | null;
	cwd: string | null;
	gitBranch: string | null;
	/** The human's first request, which is all the title a Codex session can have. */
	firstRequest: string | null;
	/** User messages the human actually sent — Codex's injected context excluded. */
	turns: number;
}

/**
 * Classify one Codex rollout body.
 *
 * `response_item` is canonical (the `event_msg` stream restates it, and vanishes
 * entirely in `codex exec` and SDK sessions), so the count comes from there with
 * Codex's own injected blocks filtered out by `isCodexInjectedUserText`.
 */
export function classifyCodexRollout(body: string): ClassifiedRollout {
	const result: ClassifiedRollout = { sessionId: null, cwd: null, gitBranch: null, firstRequest: null, turns: 0 };

	for (const line of body.split("\n")) {
		if (!line.trim()) continue;
		let record: Record<string, unknown>;
		try {
			record = JSON.parse(line) as Record<string, unknown>;
		} catch {
			continue;
		}
		const payload = record.payload as Record<string, unknown> | undefined;
		if (!payload) continue;

		if (record.type === "session_meta") {
			result.sessionId ??= stringField(payload, "id") ?? stringField(payload, "session_id");
			result.cwd ??= stringField(payload, "cwd");
			const git = payload.git as Record<string, unknown> | undefined;
			if (git) result.gitBranch ??= stringField(git, "branch");
			continue;
		}
		if (record.type === "turn_context") {
			result.cwd ??= stringField(payload, "cwd");
			continue;
		}
		if (record.type !== "response_item") continue;
		if (payload.type !== "message" || payload.role !== "user") continue;

		const text = codexMessageText(payload.content);
		if (!text.trim() || isCodexInjectedUserText(text)) continue;
		result.turns++;
		result.firstRequest ??= text.trim();
	}

	return result;
}

/** Concatenate the text blocks of a Codex `message` payload. */
function codexMessageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => {
			if (!block || typeof block !== "object") return "";
			const b = block as Record<string, unknown>;
			return typeof b.text === "string" ? b.text : "";
		})
		.join("");
}

/**
 * A one-line card title out of the request that opened the session.
 *
 * Claude ships an `ai-title` record and dev3 uses it verbatim; Codex ships
 * nothing, so the first request stands in. Cut at the first line break and at 80
 * characters — the same width the board gives an auto-generated task title.
 */
export function codexTitleFrom(firstRequest: string | null): string | null {
	const line = firstRequest?.split("\n").map((l) => l.trim()).find((l) => l.length > 0);
	if (!line) return null;
	return line.length > 80 ? `${line.slice(0, 79).trimEnd()}…` : line;
}

/** One conversation that could become a task. */
export interface ImportableConversation {
	/** Which agent CLI wrote it — decides the parser and the wording on the card. */
	source: ConversationSource;
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
	/** Data root of THIS instance. Its worktrees are rejected alongside the real one. */
	dev3Home?: string;
	nowMs?: number;
}

/** The rules every candidate is held to, whichever store it came from. */
interface ScanContext {
	home: string;
	nowMs: number;
	projectPath: string;
	/** Every spelling a store name may be encoded from — see `projectPathCandidates`. */
	projectPaths: Array<{ path: string; encoded: string }>;
	already: Set<string>;
	seenSessions: Set<string>;
	dev3Prefixes: string[];
}

/**
 * Every importable conversation for one project, newest first, from both stores.
 *
 * Claude's side opens only store directories whose name is the project's own
 * encoded path (or a subdirectory of it), so it costs a few `readdir`s plus a
 * parse of the transcripts that actually belong to the project. Codex's side has
 * no such key and pays one bounded header read per rollout instead.
 */
export function scanImportableConversations(options: ScanOptions): ImportableConversation[] {
	const home = options.home ?? resolveUserHome();
	const context: ScanContext = {
		home,
		nowMs: options.nowMs ?? Date.now(),
		projectPath: options.projectPath,
		// A store name encodes the cwd that agent recorded, which is not always the
		// project path as it was stored: a symlinked checkout records the physical
		// path, and a stored trailing slash encodes to a directory that exists
		// nowhere. Both spellings are therefore candidates, and whichever one a
		// store name matches decides what "inside the project" means for it.
		projectPaths: projectPathCandidates(options.projectPath),
		already: new Set(options.importedSessionIds ?? []),
		seenSessions: new Set<string>(),
		// Two roots, not one: a redirected instance (`DEV3_HOME`, the `--qa` board)
		// keeps its worktrees elsewhere, and conversations from EITHER set of worktrees
		// are dev3's own work, never a project's history.
		dev3Prefixes: [`${home}/.dev3.0`, options.dev3Home ?? resolveDev3Home()],
	};

	const found = [...scanClaudeStore(context), ...scanCodexStore(context)];
	return found.sort((a, b) => b.lastActivityMs - a.lastActivityMs);
}

function scanClaudeStore(context: ScanContext): ImportableConversation[] {
	const found: ImportableConversation[] = [];

	for (const storeRoot of claudeConfigDirs(context.home).map(claudeProjectsDir)) {
		for (const storeName of subdirs(storeRoot)) {
			// Cheap prefix filter, not the boundary: encoding maps `/` and `.` to `-`,
			// so a sibling `<project>-scratch` matches here too. `resolveWorkingDir`
			// is what rejects it, on the record's own cwd — do not drop that check.
			const store = context.projectPaths.find(
				(c) => storeName === c.encoded || storeName.startsWith(`${c.encoded}-`),
			);
			if (!store) continue;
			for (const file of jsonlFiles(`${storeRoot}/${storeName}`)) {
				const body = readFileSafe(file);
				if (body == null) continue;
				const classified = classifyClaudeTranscript(body);
				if (classified.kind !== "main" || !classified.sessionId || !classified.title) continue;

				const workingDir = resolveWorkingDir(classified.cwd, storeName, store.encoded, store.path);
				const candidate = admit(context, {
					source: "claude",
					sessionId: classified.sessionId,
					title: classified.title,
					workingDir,
					transcriptPath: file,
					gitBranch: classified.gitBranch,
					turns: classified.turns,
				});
				if (candidate) found.push(candidate);
			}
		}
	}

	return found;
}

/**
 * Codex rollouts belonging to this project, from the home store and every dev3
 * agent account (`CODEX_HOME` is overridden per account, so a scan of
 * `~/.codex/sessions` alone misses whole accounts' worth of history).
 *
 * An account's rollouts are almost all dev3's own work and get rejected on their
 * working directory like any other — but that is the rule doing the rejecting,
 * not the root being skipped, so a session someone ran by hand under an account
 * still shows up.
 */
function scanCodexStore(context: ScanContext): ImportableConversation[] {
	const found: ImportableConversation[] = [];

	for (const root of codexSessionRoots(context.home)) {
		for (const file of jsonlFilesDeep(root)) {
			// Phase one: the header alone says where it ran. Every rollout that did not
			// run inside the project stops here, unread.
			const head = readHead(file);
			if (head == null) continue;
			const header = codexHeaderFrom(head);
			if (!header?.cwd) continue;
			// Same spellings as the Claude side: a rollout records the physical cwd,
			// which need not be the project path as the picker stored it.
			const headerCwd = header.cwd;
			if (!withinAnyProjectPath(context, headerCwd)) continue;
			if (context.already.has(header.sessionId) || context.seenSessions.has(header.sessionId)) continue;

			// Phase two, for the few that survived: the whole body, for turns and title.
			const body = readFileSafe(file);
			if (body == null) continue;
			const classified = classifyCodexRollout(body);
			const title = codexTitleFrom(classified.firstRequest);
			// No request the human typed: a session that only ever received injected
			// context has nothing to name a card after and nothing to pick up.
			if (!title || classified.turns === 0) continue;

			const candidate = admit(context, {
				source: "codex",
				sessionId: classified.sessionId ?? header.sessionId,
				title,
				workingDir: classified.cwd ?? header.cwd,
				transcriptPath: file,
				gitBranch: classified.gitBranch,
				turns: classified.turns,
			});
			if (candidate) found.push(candidate);
		}
	}

	return found;
}

/**
 * The checks a candidate from either store has to pass, and the fields that come
 * from the file rather than its contents. Returns null when it is not importable.
 */
function admit(
	context: ScanContext,
	candidate: Omit<ImportableConversation, "lastActivityMs" | "targetStatus" | "workingDir"> & { workingDir: string | null },
): ImportableConversation | null {
	const { workingDir, sessionId } = candidate;
	if (!workingDir) return null;
	if (context.already.has(sessionId) || context.seenSessions.has(sessionId)) return null;
	// A working directory dev3 owns is never project work, and one that is gone is
	// not somewhere work can be picked up again.
	if (context.dev3Prefixes.some((p) => workingDir === p || workingDir.startsWith(`${p}/`))) return null;
	if (!withinAnyProjectPath(context, workingDir)) return null;
	if (!existsSync(workingDir)) return null;

	const lastActivityMs = mtimeMsOf(candidate.transcriptPath);
	if (lastActivityMs == null) return null;

	context.seenSessions.add(sessionId);
	return {
		...candidate,
		workingDir,
		lastActivityMs,
		targetStatus: context.nowMs - lastActivityMs <= RECENT_ACTIVITY_WINDOW_MS ? "user-questions" : "completed",
	};
}

/** Containment on a path boundary, so `/p/dev-3.0-scratch` is not read as `/p/dev-3.0`. */
function withinProject(dir: string, projectPath: string): boolean {
	return dir === projectPath || dir.startsWith(`${projectPath}/`);
}

/** Inside the project under ANY spelling of its path — see `projectPathCandidates`. */
function withinAnyProjectPath(context: ScanContext, dir: string): boolean {
	return context.projectPaths.some((c) => withinProject(dir, c.path));
}

/**
 * Every spelling of the project path a Claude store name may legitimately be
 * encoded from, most literal first.
 *
 * The stored path is what the folder picker produced; the recorded cwd is what
 * that agent's shell reported. They differ in two ways that both make the encoded
 * store name miss: a trailing slash (which the encoder turns into a trailing `-`),
 * and a symlinked checkout (where the recorded cwd is the physical path).
 *
 * The stored path is NOT rewritten anywhere else — `projectStorageKey` turns it
 * into the project's data directory and that mapping is frozen (AGENTS.md).
 */
export function projectPathCandidates(projectPath: string): Array<{ path: string; encoded: string }> {
	const paths = [toPosixSeparators(projectPath).replace(/\/+$/, "")];
	try {
		const physical = toPosixSeparators(realpathSync(projectPath)).replace(/\/+$/, "");
		if (!paths.includes(physical)) paths.push(physical);
	} catch {
		// Unmounted volume, or a path that is not on this machine at all.
	}
	return paths.map((path) => ({ path, encoded: claudeEncodePath(path) }));
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

/**
 * Every `.jsonl` under a directory tree. Codex files sit three levels down
 * (`<Y>/<M>/<D>`), but the depth is Codex's business and may change, so the walk
 * follows whatever is there rather than assuming the shape.
 */
function jsonlFilesDeep(dir: string): string[] {
	const found: string[] = [];
	const pending = [dir];
	while (pending.length > 0) {
		const current = pending.pop() as string;
		let entries: Dirent[];
		try {
			entries = readdirSync(current, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			const path = `${current}/${entry.name}`;
			if (entry.isDirectory()) pending.push(path);
			else if (entry.name.endsWith(".jsonl")) found.push(path);
		}
	}
	return found;
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
