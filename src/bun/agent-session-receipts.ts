/**
 * What dev3 knows about one agent session it spawned, keyed by the session id
 * it pre-assigned with `--session-id`. That id is minted per spawn, so a
 * replaced or previous agent can never answer for this one.
 *
 * - launched: this app process spawned it fresh (a `startup` session).
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
	startedAt: number | null;
	/** `TMUX_PANE` / `DEV3_PANE_ID` the started hook ran in. */
	paneId: string | null;
	exitedAt: number | null;
	exitCode: number | null;
}

const MAX_RECORDS = 500;
const records = new Map<string, AgentSessionRecord>();

function keyOf(taskId: string, sessionId: string): string {
	return `${taskId}:${sessionId}`;
}

function update(taskId: string, sessionId: string, change: Partial<AgentSessionRecord>): AgentSessionRecord {
	const key = keyOf(taskId, sessionId);
	const next: AgentSessionRecord = {
		launchedAt: null,
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

export function noteAgentLaunched(taskId: string, sessionId: string, at = Date.now()): void {
	update(taskId, sessionId, { launchedAt: at, startedAt: null, paneId: null, exitedAt: null, exitCode: null });
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
 * Record the exit and say whether it ended a session this process launched
 * that never got past its startup dialogs.
 */
export function noteAgentExited(taskId: string, sessionId: string, exitCode: number | null, at = Date.now()): boolean {
	const record = update(taskId, sessionId, { exitedAt: at, exitCode });
	return record.launchedAt !== null && record.startedAt === null;
}

export function agentSessionRecord(taskId: string, sessionId: string): AgentSessionRecord | null {
	return records.get(keyOf(taskId, sessionId)) ?? null;
}

export function resetAgentSessionRecordsForTests(): void {
	records.clear();
}
