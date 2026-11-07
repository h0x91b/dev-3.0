/**
 * What dev3 knows about one agent it spawned, keyed by a launch id minted per
 * spawn: the session id Claude gets with `--session-id`, or a bare launch id for
 * every other harness. Only the task's latest launch may move its card, so a
 * replaced or previous agent can never answer for this one.
 *
 * - launched: this app process spawned it. `startReceipts` says whether the
 *   harness reports SessionStart (Claude) — without it, `started` never fills.
 * - started:  Claude's `SessionStart` hook fired from it. Claude does not fire it
 *   while the trust or onboarding dialog is on screen (measured on 2.1.273 and
 *   2.1.310), so it is the evidence that typing into the pane is safe.
 * - exited:   the launch wrapper saw the agent process end.
 *
 * Only the launch handoff and the early-exit report read this, so nothing here
 * can hold back an ordinary `dev3 message` — the failure that reverted #1792.
 * In memory only: an app restart forgets it, and both readers then do nothing.
 */

/** Socket methods the hook CLI sends; also the strings `hookCliSupports` looks for. */
export const AGENT_SESSION_STARTED_METHOD = "agent.sessionStarted";
export const AGENT_EXITED_METHOD = "agent.exited";

export interface AgentSessionRecord {
	launchedAt: number | null;
	startReceipts: boolean;
	startedAt: number | null;
	/** `TMUX_PANE` / `DEV3_PANE_ID` the started hook ran in. */
	paneId: string | null;
	exitedAt: number | null;
	exitCode: number | null;
}

const MAX_RECORDS = 500;
const records = new Map<string, AgentSessionRecord>();
const latestLaunch = new Map<string, string>();

function keyOf(taskId: string, sessionId: string): string {
	return `${taskId}:${sessionId}`;
}

function update(taskId: string, sessionId: string, change: Partial<AgentSessionRecord>): AgentSessionRecord {
	const key = keyOf(taskId, sessionId);
	const next: AgentSessionRecord = {
		launchedAt: null,
		startReceipts: false,
		startedAt: null,
		paneId: null,
		exitedAt: null,
		exitCode: null,
		...records.get(key),
		...change,
	};
	records.delete(key);
	records.set(key, next);
	while (records.size > MAX_RECORDS) records.delete(records.keys().next().value!);
	return next;
}

export function noteAgentLaunched(taskId: string, sessionId: string, opts: { startReceipts: boolean }, at = Date.now()): void {
	update(taskId, sessionId, { launchedAt: at, startReceipts: opts.startReceipts, startedAt: null, paneId: null, exitedAt: null, exitCode: null });
	latestLaunch.delete(taskId);
	latestLaunch.set(taskId, sessionId);
	while (latestLaunch.size > MAX_RECORDS) latestLaunch.delete(latestLaunch.keys().next().value!);
}

export function noteAgentSessionStarted(taskId: string, sessionId: string, paneId: string | null, at = Date.now()): void {
	update(taskId, sessionId, { startedAt: at, paneId });
}

/**
 * Any later sign of life from the session — a prompt, a turn end, SessionEnd on
 * a graceful exit — also proves it got past its dialogs, should the SessionStart
 * receipt itself have been lost. Only touches a session this process launched.
 */
export function noteAgentSessionActive(taskId: string, sessionId: string, paneId: string | null, at = Date.now()): void {
	const record = records.get(keyOf(taskId, sessionId));
	if (!record || record.startedAt !== null) return;
	update(taskId, sessionId, { startedAt: at, paneId: paneId ?? record.paneId });
}

/**
 * Why an exit should take the card off Agent is Working, if it should:
 * - early:   a session with start receipts ended before SessionStart (any code);
 * - crashed: the agent ended with a non-zero code, whatever the harness.
 */
export type AgentExitVerdict = "early" | "crashed" | null;

/**
 * Record the exit and judge it. Only the task's latest launch from this app
 * process counts: a stale wrapper from a replaced agent never moves the card.
 */
export function noteAgentExited(taskId: string, sessionId: string, exitCode: number | null, at = Date.now()): AgentExitVerdict {
	const record = update(taskId, sessionId, { exitedAt: at, exitCode });
	if (record.launchedAt === null || latestLaunch.get(taskId) !== sessionId) return null;
	if (record.startReceipts && record.startedAt === null) return "early";
	return exitCode !== null && exitCode !== 0 ? "crashed" : null;
}

export function agentSessionRecord(taskId: string, sessionId: string): AgentSessionRecord | null {
	return records.get(keyOf(taskId, sessionId)) ?? null;
}

export function resetAgentSessionRecordsForTests(): void {
	records.clear();
	latestLaunch.clear();
}
