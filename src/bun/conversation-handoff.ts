import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import type { Task } from "../shared/types";
import type { HandoffPreview } from "../shared/conversation-handoff-model";
import type { RenderTarget } from "../shared/conversation-render";
import { conversationDumpDir, type TranscriptFingerprint } from "./conversation-parse";
import { runHandoffJob } from "./conversation-handoff-runner";
import { atomicWriteFile } from "./atomic-write";

/**
 * Handing one task's live conversation to a different agent.
 *
 * A cross-client resume does not exist and cannot be built: `--resume` reads only
 * its own store, Claude signs its reasoning blocks, and the two tool sets do not
 * intersect. So this is a *retelling* — `renderHandoffFile` writes it, and the new
 * agent is told where to read it.
 *
 * Delivery is a file plus a one-line pointer, never the text itself: the retelling
 * runs to tens of thousands of characters, and pane input silently truncates long
 * bodies. The file also outlives the pane, so the takeover can be re-read.
 */

export interface PreparedHandoff extends HandoffPreview {
	path: string;
	/** Characters actually written, after the file budget trimmed the tail to fit. */
	chars: number;
}

/** Where a task's handoff files live: beside its dumps, in the durable container. */
function handoffDir(worktreePath: string): string {
	return conversationDumpDir(dirname(worktreePath));
}

/** Long enough for a multi-GB rollout under memory pressure, short of the 2-minute RPC timeout. */
const PREVIEW_TIMEOUT_MS = 90_000;
const RENDER_TIMEOUT_MS = 100_000;
const PREVIEW_CACHE_LIMIT = 200;

interface CachedPreview {
	fingerprint: TranscriptFingerprint;
	preview: HandoffPreview;
}

/** Newest-transcript fingerprint → preview, so reopening + Agent parses nothing unless the file moved. */
const previewCache = new Map<string, CachedPreview>();
/** One scan per worktree at a time: reopening the dialog joins the running one. */
const previewsInFlight = new Map<string, Promise<HandoffPreview | null>>();

function rememberPreview(worktreePath: string, entry: CachedPreview): void {
	previewCache.delete(worktreePath);
	previewCache.set(worktreePath, entry);
	if (previewCache.size > PREVIEW_CACHE_LIMIT) previewCache.delete(previewCache.keys().next().value as string);
}

async function scanPreview(worktreePath: string, home: string): Promise<HandoffPreview | null> {
	const cached = previewCache.get(worktreePath);
	const result = await runHandoffJob(
		{ kind: "preview", worktreePath, home, known: cached?.fingerprint ?? null },
		{ timeoutMs: PREVIEW_TIMEOUT_MS },
	);
	if (result.kind === "unchanged" && cached) return cached.preview;
	if (result.kind === "preview") {
		rememberPreview(worktreePath, { fingerprint: result.fingerprint, preview: result.preview });
		return result.preview;
	}
	previewCache.delete(worktreePath);
	return null;
}

/**
 * The conversation a handoff would retell: the task's most recently written
 * transcript. Null when the task has no worktree, or nothing parseable ran in it.
 * The parse runs in the handoff worker, never on the host thread.
 */
export function previewTaskHandoff(task: Task, options: { home?: string } = {}): Promise<HandoffPreview | null> {
	const worktreePath = task.worktreePath;
	if (!worktreePath) return Promise.resolve(null);
	const running = previewsInFlight.get(worktreePath);
	if (running) return running;
	const scan = scanPreview(worktreePath, options.home ?? homedir()).finally(() => previewsInFlight.delete(worktreePath));
	previewsInFlight.set(worktreePath, scan);
	return scan;
}

/** Test seam: forget cached previews between cases. */
export function _resetHandoffPreviewCacheForTests(): void {
	previewCache.clear();
	previewsInFlight.clear();
}

/**
 * Write the retelling of this task's newest conversation and return where it went.
 *
 * The filename carries the source and its session, so a task handed over twice
 * keeps both files and a repeat of the same session overwrites its own.
 */
export async function prepareTaskHandoff(
	task: Task,
	options: { home?: string; target?: RenderTarget } = {},
): Promise<PreparedHandoff | null> {
	if (!task.worktreePath) return null;
	const result = await runHandoffJob(
		{ kind: "render", worktreePath: task.worktreePath, home: options.home ?? homedir(), target: options.target ?? "claude" },
		{ timeoutMs: RENDER_TIMEOUT_MS },
	);
	if (result.kind !== "render") return null;

	const { preview, text } = result;
	const dir = handoffDir(task.worktreePath);
	mkdirSync(dir, { recursive: true });
	const path = `${dir}/handoff-${preview.source}-${preview.sessionId ?? "no-session"}.md`;
	await atomicWriteFile(path, text);

	return { path, ...preview, chars: text.length };
}

/**
 * The line typed into the new agent's pane. Short by necessity and blunt on
 * purpose: the one thing that must not be misread is that the actions in the file
 * belong to a previous agent and nothing in it is still running.
 */
export function handoffPrompt(handoff: PreparedHandoff): string {
	const previous = handoff.source === "claude" ? "Claude Code" : "Codex";
	return (
		`You are taking over work that ran in ${previous}, in this same worktree. ` +
		`Read ${handoff.path} in full before anything else. ` +
		`It is a RETELLING of that conversation written by dev3, not a transcript of your own: ` +
		`prompts and replies are verbatim, tool calls are reduced to what they did, and tool output is truncated. ` +
		`You did none of it, and nothing in it is still running. ` +
		`Re-read any file you need to be sure about, then continue the work from where it stopped.`
	);
}
