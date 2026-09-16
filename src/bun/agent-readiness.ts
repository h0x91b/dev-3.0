/**
 * Has a task's agent reached the point where typed input lands in its own input
 * box — and is an agent session still open in the pane we are about to type into?
 *
 * This exists because "the pane is up" is not "the agent is listening". A freshly
 * launched agent spends its first seconds in its OWN modal dialogs: Claude Code's
 * workspace-trust prompt, its first-run theme wizard, a login prompt. Those
 * dialogs swallow pasted text and read the next Enter as an answer — and the
 * highlighted default on the trust dialog is "No, exit". dev3's peer-launch
 * handoff used to be typed on a pane-exists test alone, so it answered that
 * dialog for the human and killed the agent it had just started, then spilled the
 * rest of the note into the bare shell left behind (h0x91b/dev-3.0#1785).
 *
 * The answer is EVIDENCE, never a timer. A guessed "wait N seconds" is the same
 * bug with a different number in it: a human may take a minute to read a trust
 * dialog, and a machine on a cold cache may take longer than the guess to boot.
 * So readiness is three-valued and only ever blocks on a positive "not yet":
 *
 * - `ready`   — a lifecycle receipt arrived from an agent session that is still
 *               open. Startup dialogs are behind it.
 * - `booting` — dev3 launched an agent whose harness DOES report lifecycle events,
 *               and that launch has not reported in. The one state that blocks.
 * - `gone`    — every session that reported in has since reported out.
 * - `unknown` — no launch was recorded in this app run, or the harness emits no
 *               lifecycle events at all. Never blocks: a harness we have no probe
 *               for must not be held hostage by our own ignorance (same rule as
 *               `harness-readiness.ts`).
 *
 * Three things make the answer specific rather than a task-wide mood:
 *
 * 1. **A generation token.** Every launch gets a `launchId`, injected into the
 *    agent's environment as `DEV3_LAUNCH_ID` and echoed back by its lifecycle
 *    hook. A receipt naming a launch this task no longer knows is REJECTED — so a
 *    slow hook from the agent we just replaced cannot bless the one now booting.
 *    Clearing a map would not do this: the old process's receipt would simply
 *    arrive afterwards and look new.
 * 2. **Pane identity, and no borrowing.** A receipt carries the pane it came from
 *    (`TMUX_PANE` / `DEV3_PANE_ID`), so a send aimed at one pane is judged on
 *    THAT pane. A named pane dev3 has no evidence about is NOT ready and never
 *    inherits the task's answer — a ready main agent may not vouch for a hunter
 *    pane whose own dialog could still be open.
 * 3. **An unresolved target is judged strictly.** A send to "the task's agent"
 *    picks its pane deep inside the backend, so dev3 cannot prove where the text
 *    lands; while ANY pane of the task is still booting, that send is refused.
 *
 * State is per app run and deliberately in memory: a receipt proves something
 * about a live process, and a stale one read back from disk would prove nothing.
 */

import { createLogger } from "./logger";

const log = createLogger("agent-readiness");

export type AgentReadiness = "ready" | "booting" | "gone" | "unknown";

/**
 * A boot window closes on evidence, never on a clock.
 *
 * The obvious-looking alternative — expire a pane that has sat unreported for
 * long enough — is wrong, and worth stating so nobody adds it back: elapsed time
 * is not proof that a pane became ready or went away. A pane whose agent is
 * STILL sitting in its trust dialog would be un-gated by its own timeout, which
 * is exactly the failure this module exists to prevent. What does close a window
 * is a receipt, a session end, or the pane ceasing to exist
 * ({@link forgetAgentPaneLaunch}).
 *
 * A caller that cannot wait forever bounds its own DELIVERY instead, and says so
 * out loud — see `agent-launch-handoff.ts` and the scheduled-message scheduler.
 */

interface PendingLaunch {
	readonly launchId: string;
	readonly paneId: string | null;
	readonly at: number;
	/** The task's own agent, as opposed to an extra pane spawned into it. */
	readonly primary: boolean;
}

interface ReadinessRecord {
	/** Launch ids this task still recognises. A receipt naming anything else is stale. */
	readonly launchIds: Set<string>;
	/** Launches that have not reported in yet. */
	pending: PendingLaunch[];
	/** Open agent sessions: harness session id → the pane it reported from. */
	readonly sessions: Map<string, string | null>;
	/** Panes that have had a session open at some point in this era. */
	readonly everReadyPanes: Set<string>;
	/** Whether any session at all ever reported in during this era. */
	everReady: boolean;
}

const records = new Map<string, ReadinessRecord>();

/**
 * A harness that reports no session id still deserves one slot, so its start and
 * end pair up instead of accumulating.
 */
const UNKEYED_SESSION = " unkeyed";

function sessionKey(sessionId: string | null | undefined): string {
	return sessionId?.trim() || UNKEYED_SESSION;
}

function clean(value: string | null | undefined): string | null {
	const trimmed = value?.trim();
	return trimmed ? trimmed : null;
}

function emptyRecord(): ReadinessRecord {
	return {
		launchIds: new Set(),
		pending: [],
		sessions: new Map(),
		everReadyPanes: new Set(),
		everReady: false,
	};
}

export interface LaunchRegistration {
	/** `AgentAdapter.hooksSpec() !== null` — can this harness report at all? */
	reportsLifecycle: boolean;
	/** The task's own agent launch, which resets the era. False for an extra pane. */
	primary: boolean;
	/** The pane this agent is being launched into, when the caller already knows it. */
	paneId?: string | null;
	now?: number;
}

/**
 * Record that dev3 is launching an agent, and return the `launchId` to inject
 * into its environment as `DEV3_LAUNCH_ID`.
 *
 * A `primary` launch starts a new era: every previous launch id, session and
 * pending entry is discarded, so nothing the old agent says later counts. An
 * extra pane joins the current era instead of replacing it.
 *
 * Returns null when this harness reports no lifecycle events — the record is
 * dropped so the task reads `unknown` and is never blocked by a window that
 * nothing could ever close.
 */
export function noteAgentLaunching(taskId: string, opts: LaunchRegistration): string | null {
	if (!opts.reportsLifecycle) {
		if (opts.primary) records.delete(taskId);
		return null;
	}
	const record = opts.primary ? emptyRecord() : records.get(taskId) ?? emptyRecord();
	const launchId = crypto.randomUUID();
	record.launchIds.add(launchId);
	record.pending.push({
		launchId,
		paneId: clean(opts.paneId),
		at: opts.now ?? Date.now(),
		primary: opts.primary,
	});
	records.set(taskId, record);
	log.debug("Agent launch recorded", { taskId: taskId.slice(0, 8), primary: opts.primary, paneId: opts.paneId ?? null });
	return launchId;
}

/**
 * Which boot window a receipt closes.
 *
 * Only the launch id it echoed back closes a window, plus the pane as a
 * secondary match for a receipt whose own window was already closed. There is
 * deliberately no "if there is exactly one window open it must be that one"
 * rule: a receipt that cannot name its launch is not evidence about a launch,
 * and treating it as one is the fail-open this module exists to prevent.
 */
function closeBootWindow(
	pending: PendingLaunch[],
	launchId: string | null,
	paneId: string | null,
): PendingLaunch[] {
	if (launchId) return pending.filter((launch) => launch.launchId !== launchId);
	if (paneId) return pending.filter((launch) => launch.paneId !== paneId);
	return pending;
}

export interface SessionReceipt {
	sessionId?: string | null;
	/** `TMUX_PANE` / `DEV3_PANE_ID` as seen by the hook process. */
	paneId?: string | null;
	/** `DEV3_LAUNCH_ID` as seen by the hook process. */
	launchId?: string | null;
}

/**
 * Whether a receipt belongs to a launch this task still recognises.
 *
 * Two rules, and the second one is the one that is easy to get wrong:
 *
 * - A receipt that NAMES a launch must name one this task still knows. That is
 *   what stops the agent dev3 just replaced from blessing the one now booting.
 * - A receipt that names NO launch may not touch a task with a launch
 *   outstanding. It would otherwise walk straight past the token: anything that
 *   can reach the socket without one — an older CLI, a delayed hook, a hand-run
 *   command — would unlock a generation it knows nothing about. Measured: a
 *   hand-fired tokenless receipt flipped a `booting` task to `ready`, which is
 *   exactly the hole the token was added to close.
 *
 * A tokenless receipt is still accepted when nothing is pending — an app restart,
 * a resumed session, or an agent the user started by hand can only report that
 * way, and with no window open there is no generation for it to bless.
 */
function receiptIsCurrent(record: ReadinessRecord, launchId: string | null): boolean {
	if (launchId) return record.launchIds.has(launchId);
	return record.pending.length === 0;
}

/**
 * A lifecycle receipt arrived from an agent session — any event at all, since
 * every one of them is proof the harness is past its startup dialogs.
 *
 * Returns whether the receipt counted, so the caller can log a stale one rather
 * than silently swallowing it.
 */
export function noteAgentSessionAlive(taskId: string, receipt: SessionReceipt = {}): boolean {
	const launchId = clean(receipt.launchId);
	const paneId = clean(receipt.paneId);
	const record = records.get(taskId) ?? emptyRecord();

	if (!receiptIsCurrent(record, launchId)) {
		// warn, not info: a run of these means every message to this task is being
		// refused, and the usual cause is a CLI in ~/.dev3.0/bin that predates the
		// session hook, which nothing else would ever say out loud.
		log.warn("Ignoring a lifecycle receipt that cannot prove which launch it belongs to", {
			taskId: taskId.slice(0, 8),
			launchId: launchId ?? "none",
			pending: record.pending.length,
		});
		return false;
	}

	record.sessions.set(sessionKey(receipt.sessionId), paneId);
	record.everReady = true;
	if (paneId) record.everReadyPanes.add(paneId);
	record.pending = closeBootWindow(record.pending, launchId, paneId);
	records.set(taskId, record);
	return true;
}

/**
 * That agent session ended. Only the session named here is forgotten, so a task
 * running several agent panes stays ready while any of them is still open.
 *
 * An end for a task we know nothing about is ignored rather than treated as the
 * end of everything — it is evidence about one session, not about the task.
 */
export function noteAgentSessionEnded(taskId: string, receipt: SessionReceipt = {}): boolean {
	const record = records.get(taskId);
	if (!record) return false;
	if (!receiptIsCurrent(record, clean(receipt.launchId))) return false;
	record.sessions.delete(sessionKey(receipt.sessionId));
	return true;
}

/**
 * May dev3 type into this task's agent right now?
 *
 * `paneId` is the pane the text is actually going into, when the caller can name
 * it. Without one the answer is deliberately strict: a send that resolves its own
 * pane inside the backend could land in whichever pane is still booting.
 */
export function agentReadiness(taskId: string, paneId?: string | null): AgentReadiness {
	const record = records.get(taskId);
	if (!record) return "unknown";

	const pane = clean(paneId);
	if (pane) {
		for (const sessionPane of record.sessions.values()) {
			if (sessionPane === pane) return "ready";
		}
		if (record.pending.some((launch) => launch.paneId === pane)) return "booting";
		if (record.everReadyPanes.has(pane)) return "gone";
		// A named pane dev3 has no evidence about is NOT ready, and never inherits
		// the task's answer. Falling through would let a sibling agent's receipt
		// authorize typing into a pane whose own agent may still have a dialog open
		// — the precise mistake a pane-targeted send exists to avoid.
		return "booting";
	}

	// Strictest first: while anything is still booting, an unproved destination is
	// refused even though a sibling pane is happily running.
	if (record.pending.length > 0) return "booting";
	if (record.sessions.size > 0) return "ready";
	return record.everReady ? "gone" : "unknown";
}

/** Whether dev3 may type into this task's agent (or one concrete pane) right now. */
export function agentAcceptsTypedInput(taskId: string, paneId?: string | null): boolean {
	const state = agentReadiness(taskId, paneId);
	return state === "ready" || state === "unknown";
}

/**
 * A pane is gone for real — tmux reported it dead, or dev3 killed it. That IS
 * evidence, unlike elapsed time, so its boot window closes and its sessions are
 * forgotten. Without this a pane that died inside its own trust dialog would keep
 * the whole task unable to receive a message, with nothing left to report in.
 */
export function forgetAgentPaneLaunch(taskId: string, paneId: string | null | undefined): void {
	const record = records.get(taskId);
	const pane = clean(paneId);
	if (!record || !pane) return;
	record.pending = record.pending.filter((launch) => launch.paneId !== pane);
	for (const [sessionId, sessionPane] of [...record.sessions]) {
		if (sessionPane === pane) record.sessions.delete(sessionId);
	}
	record.everReadyPanes.delete(pane);
}

/**
 * How long a caller that must type into a pane it just created will wait for that
 * pane's agent to report in. A ceiling on the WAIT, never on the gate: when it
 * expires the answer is still "not ready", and nothing is typed.
 */
export const AGENT_READINESS_WAIT_MS = 120_000;

/**
 * Block until this pane's agent is past its startup dialogs, or until the wait
 * runs out. Returns whatever the state is at the end, so the caller decides what
 * a timeout means for it — this function never decides to type.
 *
 * For the one caller that has no alternative: a bug-hunter pane's first prompt is
 * pasted into an agent dev3 created a moment ago, which is precisely the moment
 * a trust or login dialog would be on screen.
 */
export async function waitForAgentReadiness(
	taskId: string,
	paneId: string | null | undefined,
	opts: { timeoutMs?: number; pollMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number } = {},
): Promise<AgentReadiness> {
	const timeoutMs = opts.timeoutMs ?? AGENT_READINESS_WAIT_MS;
	const pollMs = opts.pollMs ?? 250;
	const now = opts.now ?? (() => Date.now());
	const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	const deadline = now() + timeoutMs;

	for (;;) {
		const state = agentReadiness(taskId, paneId);
		if (state !== "booting") return state;
		if (now() >= deadline) return state;
		await sleep(pollMs);
	}
}

/** Drop everything remembered about a task (teardown, backend switch, tests). */
export function forgetAgentReadiness(taskId: string): void {
	records.delete(taskId);
}

/** Test seam — the module owns process-wide state. */
export function resetAgentReadinessForTests(): void {
	records.clear();
}
