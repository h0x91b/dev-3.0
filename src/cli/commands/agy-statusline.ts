import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { AGY_WAIT_HEARTBEAT_MS, agyDev3Home, agyPaneKey, agyStatuslineStateFile } from "../../shared/agy-statusline-state";
import { parseAgyQuotaDump } from "../../shared/rate-limits";
import type { CliContext } from "../context";
import { reportStatusHookEvent } from "./status-hook-request";

/** A dump written within this long ago with the same quota is not rewritten. */
const DUMP_REFRESH_MS = 30_000;
export const AGY_CONVERSATION_ID = /^[A-Za-z0-9._-]+$/;

interface AgyStatusLinePayload {
	quota: unknown;
	email: string | null;
	planTier: string | null;
	conversationId: string | null;
	toolConfirmationPending: boolean;
	/** agy's own state (`idle` between turns, `tool_use` while a tool waits). */
	agentState: string | null;
}

function text(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value : null;
}

/** A conversation id ends up in a resume command line, so anything but a plain token is dropped. */
export function validConversationId(value: unknown): string | null {
	const id = text(value);
	return id && AGY_CONVERSATION_ID.test(id) ? id : null;
}

function parsePayload(raw: string): AgyStatusLinePayload | null {
	try {
		const parsed = JSON.parse(raw) as Record<string, unknown> | null;
		if (!parsed || typeof parsed !== "object") return null;
		return {
			quota: parsed.quota,
			email: text(parsed.email),
			planTier: text(parsed.plan_tier),
			conversationId: validConversationId(parsed.conversation_id),
			toolConfirmationPending: parsed.tool_confirmation_pending === true,
			agentState: text(parsed.agent_state),
		};
	} catch {
		return null;
	}
}

/** A stable, filesystem-safe name for one account's dump; the email itself is never part of a path. */
export function agyAccountKey(email: string | null): string {
	return createHash("sha256").update(email ?? "").digest("hex").slice(0, 16);
}

export function agyDumpPath(email: string | null, dev3Home: string = agyDev3Home()): string {
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

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/**
 * What a reading means, minus what merely ticks: `reset_in_seconds` is a countdown that
 * changes at every refresh, so only the fraction left and the reset instant are compared.
 */
function quotaIdentity(quota: Record<string, unknown> | null): string {
	return JSON.stringify(
		Object.entries(quota ?? {}).map(([id, raw]) => {
			const bucket = asRecord(raw);
			return [id, bucket?.remaining_fraction ?? null, bucket?.reset_time ?? null];
		}),
	);
}

/**
 * Dump the account's quota for the rate-limit monitor. A reading carries only the buckets agy
 * reports right now, so it is merged into the last dump per bucket: one that is missing keeps
 * its previous value. An unchanged reading is not rewritten within DUMP_REFRESH_MS.
 */
function dumpQuota(payload: AgyStatusLinePayload, now: number, dev3Home: string): void {
	const fresh = asRecord(payload.quota);
	if (!fresh || !parseAgyQuotaDump({ capturedAt: now, email: payload.email, planTier: payload.planTier, quota: fresh }, agyAccountKey(payload.email))) return;
	const path = agyDumpPath(payload.email, dev3Home);
	const previous = readJson(path);
	const merged = { ...(asRecord(previous?.quota) ?? {}), ...fresh };
	if (
		previous &&
		typeof previous.capturedAt === "number" &&
		now - previous.capturedAt < DUMP_REFRESH_MS &&
		quotaIdentity(merged) === quotaIdentity(asRecord(previous.quota))
	) {
		return;
	}
	writeJson(path, { capturedAt: now, email: payload.email, planTier: payload.planTier, quota: merged });
}

interface PaneState {
	pending: boolean;
	conversationId: string | null;
	/** When this pane last told the app about its wait (the report or a heartbeat). */
	lastSent: number | null;
}

/** Forget one pane's reported state, so what a restarted agy reports is judged fresh. */
export function resetAgyStatuslineState(
	taskId: string,
	env: Record<string, string | undefined>,
	conversationId: string | null,
	dev3Home: string = agyDev3Home(env),
): void {
	try {
		const file = agyStatuslineStateFile(dev3Home, taskId, agyPaneKey(env, conversationId));
		if (file) rmSync(file, { force: true });
	} catch {
		// a leftover file only costs one repeated report
	}
}

/**
 * agy refreshes its statusLine constantly, so each pane's last reported state is kept
 * between runs and only a change is sent: a pending tool confirmation moves the task
 * to Has Questions, and its end hands the task back - unless agy is idle by then, because
 * a turn that ended (Esc, a reject) already settled the card. A conversation id the board
 * does not know yet is recorded (a cheap fallback for a launch without the session hook).
 * A wait that goes on is repeated every AGY_WAIT_HEARTBEAT_MS, so the app can tell it from the
 * wait of a pane that died.
 */
async function syncPaneState(
	payload: AgyStatusLinePayload,
	socketPath: string,
	context: CliContext,
	dev3Home: string,
	now: number,
): Promise<void> {
	const file = agyStatuslineStateFile(dev3Home, context.taskId, agyPaneKey(process.env, payload.conversationId));
	if (!file) return;
	const stored = readJson(file);
	const previous: PaneState = {
		pending: stored?.pending === true,
		conversationId: validConversationId(stored?.conversationId),
		lastSent: typeof stored?.lastSent === "number" ? stored.lastSent : null,
	};
	const next: PaneState = { ...previous };

	if (payload.toolConfirmationPending !== previous.pending) {
		const idle = payload.agentState === "idle";
		if (payload.toolConfirmationPending || !idle) {
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
		}
		next.pending = payload.toolConfirmationPending;
		next.lastSent = payload.toolConfirmationPending ? now : null;
	} else if (payload.toolConfirmationPending && (previous.lastSent === null || now - previous.lastSent >= AGY_WAIT_HEARTBEAT_MS)) {
		await reportStatusHookEvent(
			{
				harness: "agy",
				event: "PermissionRequest",
				heartbeat: true,
				quiet: true,
				...(payload.conversationId ? { sessionId: payload.conversationId } : {}),
			},
			socketPath,
			context,
		);
		next.lastSent = now;
	}
	if (payload.conversationId && payload.conversationId !== previous.conversationId) {
		await reportStatusHookEvent(
			{ harness: "agy", event: "SessionStart", sessionId: payload.conversationId, captureOnly: true, quiet: true },
			socketPath,
			context,
		);
		next.conversationId = payload.conversationId;
	}
	if (next.pending !== previous.pending || next.conversationId !== previous.conversationId || next.lastSent !== previous.lastSent) writeJson(file, next);
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
	dev3Home: string = agyDev3Home(),
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
		if (socketPath && context?.taskId) await syncPaneState(payload, socketPath, context, dev3Home, now);
	} catch {
		// silent by contract
	}
}
