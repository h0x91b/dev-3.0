import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveDev3Home } from "../../shared/dev3-home";
import { parseAgyQuotaDump } from "../../shared/rate-limits";
import type { CliContext } from "../context";
import { reportStatusHookEvent } from "./status-hook-request";

/** A dump written within this long ago with the same quota is not rewritten. */
const DUMP_REFRESH_MS = 30_000;
const SAFE_TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

interface AgyStatusLinePayload {
	quota: unknown;
	email: string | null;
	planTier: string | null;
	conversationId: string | null;
	toolConfirmationPending: boolean;
}

function text(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value : null;
}

function parsePayload(raw: string): AgyStatusLinePayload | null {
	try {
		const parsed = JSON.parse(raw) as Record<string, unknown> | null;
		if (!parsed || typeof parsed !== "object") return null;
		return {
			quota: parsed.quota,
			email: text(parsed.email),
			planTier: text(parsed.plan_tier),
			conversationId: text(parsed.conversation_id),
			toolConfirmationPending: parsed.tool_confirmation_pending === true,
		};
	} catch {
		return null;
	}
}

/** A stable, filesystem-safe name for one account's dump; the email itself is never part of a path. */
export function agyAccountKey(email: string | null): string {
	return createHash("sha256").update(email ?? "").digest("hex").slice(0, 16);
}

export function agyDumpPath(email: string | null, dev3Home: string = resolveDev3Home()): string {
	return join(dev3Home, "data", "rate-limits", "agy", `${agyAccountKey(email)}.json`);
}

function readJson(path: string): Record<string, unknown> | null {
	try {
		return existsSync(path) ? (JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

function writeJson(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	// One small write; the monitor tolerates a torn read by keeping its previous reading.
	writeFileSync(path, JSON.stringify(value));
}

/** Dump the account's quota for the rate-limit monitor, unless the same reading was just written. */
function dumpQuota(payload: AgyStatusLinePayload, now: number, dev3Home: string): void {
	const dump = { capturedAt: now, email: payload.email, planTier: payload.planTier, quota: payload.quota };
	if (!parseAgyQuotaDump(dump, agyAccountKey(payload.email))) return;
	const path = agyDumpPath(payload.email, dev3Home);
	const previous = readJson(path);
	if (
		previous &&
		typeof previous.capturedAt === "number" &&
		now - previous.capturedAt < DUMP_REFRESH_MS &&
		JSON.stringify(previous.quota) === JSON.stringify(payload.quota)
	) {
		return;
	}
	writeJson(path, dump);
}

interface TaskState {
	pending: boolean;
	conversationId: string | null;
}

function stateFile(taskId: string, dev3Home: string): string | null {
	return SAFE_TASK_ID.test(taskId) ? join(dev3Home, "data", "agy-statusline", `${taskId}.json`) : null;
}

/**
 * agy refreshes its statusLine constantly, so the task's last reported state is kept
 * between runs and only a change is sent: a pending tool confirmation moves the task
 * to Has Questions, its end hands the task back, and a conversation id the board does
 * not know yet is recorded (a cheap fallback for a launch without the session hook).
 */
async function syncTaskState(
	payload: AgyStatusLinePayload,
	socketPath: string,
	context: CliContext,
	dev3Home: string,
): Promise<void> {
	const file = stateFile(context.taskId, dev3Home);
	if (!file) return;
	const stored = readJson(file);
	const previous: TaskState = {
		pending: stored?.pending === true,
		conversationId: text(stored?.conversationId),
	};
	const next: TaskState = { ...previous };

	if (payload.toolConfirmationPending !== previous.pending) {
		await reportStatusHookEvent(
			{
				harness: "agy",
				event: payload.toolConfirmationPending ? "PermissionRequest" : "PostToolUse",
				quiet: true,
				...(payload.conversationId ? { sessionId: payload.conversationId } : {}),
			},
			socketPath,
			context,
		);
		next.pending = payload.toolConfirmationPending;
	}
	if (payload.conversationId && payload.conversationId !== previous.conversationId) {
		await reportStatusHookEvent(
			{ harness: "agy", event: "SessionStart", sessionId: payload.conversationId, captureOnly: true, quiet: true },
			socketPath,
			context,
		);
		next.conversationId = payload.conversationId;
	}
	if (next.pending !== previous.pending || next.conversationId !== previous.conversationId) writeJson(file, next);
}

/**
 * `dev3 statusline agy` - the statusLine agy runs on every refresh, passed through the
 * per-session `--settings`. It records the account's quota for the rate-limit panel and
 * reports tool-confirmation waits. It prints NOTHING (agy stacks it under its own line)
 * and never fails: any error is swallowed and the exit code stays 0.
 */
export async function handleAgyStatusLine(
	rawInput: string,
	options: { noLimits: boolean },
	socketPath: string | null,
	context: CliContext | null,
	now: number = Date.now(),
	dev3Home: string = resolveDev3Home(),
): Promise<void> {
	try {
		const payload = parsePayload(rawInput);
		if (!payload) return;
		if (!options.noLimits) {
			try {
				dumpQuota(payload, now, dev3Home);
			} catch {
				// disk trouble must never reach agy's status line
			}
		}
		if (socketPath && context?.taskId) await syncTaskState(payload, socketPath, context, dev3Home);
	} catch {
		// silent by contract
	}
}
