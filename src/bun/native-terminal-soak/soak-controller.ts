#!/usr/bin/env bun
/**
 * Disposable controller process for the native-session soak (seq 1301).
 *
 * The soak's "fresh controller" criterion cannot be proved by an in-process
 * reconnect: the driver still holds warm handles, caches, and a live event loop.
 * This is a genuinely separate short-lived process that knows nothing but the
 * registry root in its environment. It rediscovers every session from disk,
 * reattaches, reports the identity and the reconstructed final screen it found,
 * and exits without stopping anything.
 *
 * It prints exactly one sentinel-prefixed JSON line — no terminal content, no
 * token — and is never imported by the harness.
 */

import { NativeSessionClient } from "../native-terminal-registry/client";
import { readParserState } from "../native-terminal-registry/parser-state";
import { readRecord } from "../native-terminal-registry/record";

export const SOAK_CONTROLLER_SENTINEL = "__DEV3_SOAK_CONTROLLER_JSON__";
export const SOAK_CONTROLLER_INPUT_ENV = "DEV3_SOAK_CONTROLLER_INPUT";

interface ControllerInput {
	sessionIds: string[];
	/** Marker the last burst printed; must be visible in the reconstructed screen. */
	marker: string;
}

interface ControllerSessionVerdict {
	sessionId: string;
	discovered: boolean;
	paneId: string | null;
	hostPid: number | null;
	shellPid: number | null;
	role: string | null;
	/** Marker found in the persisted semantic screen (or its bounded scrollback). */
	markerInSnapshot: boolean;
	/** Marker found in the journal tail the host replays on attach. */
	markerInReplay: boolean;
	error: string | null;
}

function screenContains(sessionId: string, marker: string): boolean {
	const state = readParserState(sessionId)?.state;
	if (!state) return false;
	return [...state.screen, ...state.scrollback].some((line) => line.text.includes(marker));
}

function replayContains(sessionId: string, marker: string): boolean {
	const decoder = new TextDecoder();
	let text = "";
	for (const chunk of NativeSessionClient.replayJournal(sessionId)) text += decoder.decode(chunk, { stream: true });
	return text.includes(marker);
}

async function inspect(sessionId: string, marker: string): Promise<ControllerSessionVerdict> {
	const record = readRecord(sessionId);
	const verdict: ControllerSessionVerdict = {
		sessionId,
		discovered: false,
		paneId: record?.paneId ?? null,
		hostPid: record?.host.pid ?? null,
		shellPid: record?.shell.pid ?? null,
		role: null,
		markerInSnapshot: screenContains(sessionId, marker),
		markerInReplay: replayContains(sessionId, marker),
		error: null,
	};
	let client: NativeSessionClient | null = null;
	try {
		client = await NativeSessionClient.discover(sessionId, { timeoutMs: 10_000 });
		const live = await client.status({ timeoutMs: 5_000 });
		verdict.discovered = true;
		verdict.hostPid = live.hostPid;
		verdict.shellPid = live.shellPid;
		verdict.paneId = live.paneId;
		verdict.role = client.getRole();
	} catch (error) {
		verdict.error = error instanceof Error ? error.message : String(error);
	} finally {
		client?.close();
	}
	return verdict;
}

async function main(): Promise<void> {
	const raw = process.env[SOAK_CONTROLLER_INPUT_ENV];
	if (!raw) {
		process.stderr.write(`${SOAK_CONTROLLER_INPUT_ENV} is required\n`);
		process.exit(2);
	}
	const input = JSON.parse(raw) as ControllerInput;
	const sessions: ControllerSessionVerdict[] = [];
	for (const sessionId of input.sessionIds) sessions.push(await inspect(sessionId, input.marker));
	process.stdout.write(`${SOAK_CONTROLLER_SENTINEL}${JSON.stringify({ controllerPid: process.pid, sessions })}\n`);
	process.exit(0);
}

if (import.meta.main) await main();
