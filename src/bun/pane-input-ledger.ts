/**
 * At-most-once bookkeeping for pane input programs, scoped honestly: one executor
 * process, one pinned pane incarnation, one retention window. Not global dedup. Quarantine
 * guards the NATIVE path; on tmux the server serializes commands across clients.
 * See `decisions/201-backend-neutral-pane-input.md`.
 */

import { randomUUID } from "node:crypto";
import {
	paneInputCanonicalProgram,
	paneInputDeadlineMs,
	paneInputPaneKey,
	paneInputStepCount,
	type PaneInputOutcome,
	type PaneInputProgram,
	type PaneInputReason,
} from "../shared/pane-input";

/** Monotonic milliseconds — immune to a wall-clock jump mid-program. */
export function monotonicNowMs(): number {
	return Number(process.hrtime.bigint() / 1_000_000n);
}

/**
 * What an admitted executor is told, and what it owes back: when `signal` aborts, stop
 * dispatching and resolve only once the backend is CONFIRMED stopped. The ledger holds
 * this pane until then, so a successor can never overlap a program that might write.
 */
export interface PaneInputExecution {
	readonly progress: (acceptedThrough: number) => void;
	/** Monotonic ms after which the program must stop. Set at admission. */
	readonly deadlineAtMs: number;
	readonly signal: AbortSignal;
}

export interface PaneInputLedgerOptions {
	/** Injected clock, so a test can prove expiry without waiting for it. */
	readonly now?: () => number;
	readonly retentionMs?: number;
	readonly maxRecords?: number;
	/** How long past its deadline an executor may still be waited on. */
	readonly graceMs?: number;
	/** How long an aborted executor gets to confirm its backend stopped. */
	readonly confirmMs?: number;
	/** Identity stamped on every outcome; defaults to this process. */
	readonly incarnation?: string;
}

interface Entry {
	/** The canonical program, compared byte for byte against a probe. */
	readonly canonical: string;
	readonly done: Promise<PaneInputOutcome>;
	acceptedThrough: number;
	settled: boolean;
	settledAtMs: number;
}

/**
 * One ledger: its own records, pane queues, quarantine and clock. Production runs a
 * single instance; a test builds its own with short windows, so nothing a test does can
 * reach production state.
 */
export class PaneInputLedger {
	readonly incarnation: string;
	private readonly now: () => number;
	private readonly retentionMs: number;
	private readonly maxRecords: number;
	private readonly graceMs: number;
	private readonly confirmMs: number;
	private readonly entries = new Map<string, Entry>();
	/** Tail of the queue for each pane; programs chain onto it so they never overlap. */
	private readonly paneQueues = new Map<string, Promise<unknown>>();
	/** Pane incarnations whose last program could not be confirmed stopped. */
	private readonly quarantined = new Map<string, string>();

	constructor(opts: PaneInputLedgerOptions = {}) {
		this.incarnation = opts.incarnation ?? `${process.pid}:${randomUUID().slice(0, 8)}`;
		this.now = opts.now ?? monotonicNowMs;
		this.retentionMs = opts.retentionMs ?? 60_000;
		this.maxRecords = opts.maxRecords ?? 64;
		this.graceMs = opts.graceMs ?? 2_000;
		this.confirmMs = opts.confirmMs ?? 3_000;
	}

	/**
	 * Run `program` at most once. A known id with the same payload joins the ORIGINAL
	 * promise; a different payload is refused; a probe with no record never executes.
	 */
	async run(
		program: PaneInputProgram,
		execute: (execution: PaneInputExecution) => Promise<PaneInputOutcome>,
	): Promise<PaneInputOutcome> {
		this.pruneExpired();
		const key = this.entryKey(program);
		const canonical = paneInputCanonicalProgram(program);
		const existing = this.entries.get(key);

		if (existing) {
			if (existing.canonical !== canonical) {
				return this.refuse(program, "not-started", "duplicate-mismatch", "this delivery id was already used for a different payload");
			}
			return existing.done;
		}

		if (program.attempt > 1) {
			return this.refuse(
				program,
				"indeterminate",
				"owner-process-replaced",
				`attempt ${program.attempt} reached ${this.incarnation}, which holds no record of this delivery`,
			);
		}

		const paneKey = paneInputPaneKey(program.incarnation);
		const closed = this.quarantined.get(paneKey);
		if (closed) {
			return this.refuse(program, "indeterminate", "backend-failure", `this pane incarnation is quarantined: ${closed}`);
		}

		if (this.entries.size >= this.maxRecords && !this.makeRoom()) {
			return this.refuse(
				program,
				"not-started",
				"executor-saturated",
				`${this.maxRecords} deliveries are in flight in this process; nothing was admitted`,
				true,
			);
		}

		const previous = this.paneQueues.get(paneKey) ?? Promise.resolve();
		const entry: Entry = {
			canonical,
			acceptedThrough: 0,
			settled: false,
			settledAtMs: 0,
			done: undefined as unknown as Promise<PaneInputOutcome>,
		};
		// The deadline starts at admission, so queue time counts against the budget.
		const deadlineAtMs = this.now() + paneInputDeadlineMs(program);
		const done = previous
			.catch(() => undefined) // a failed predecessor must not poison the queue
			.then(() => this.guarded(program, execute, entry, paneKey, deadlineAtMs))
			.then(
				(outcome) => {
					// Settle on BOTH paths: a rejected executor left in flight would be
					// un-evictable and would saturate the ledger forever.
					this.settle(entry);
					return { ...outcome, executor: this.incarnation };
				},
				(err) => {
					this.settle(entry);
					throw err;
				},
			);
		(entry as { done: Promise<PaneInputOutcome> }).done = done;
		this.entries.set(key, entry);
		this.paneQueues.set(paneKey, done);

		try {
			return await done;
		} finally {
			if (this.paneQueues.get(paneKey) === done) this.paneQueues.delete(paneKey);
		}
	}

	/**
	 * Run the executor, and on its deadline abort it and WAIT for a confirmed stop. What
	 * this returns is what the pane's queue chains on, so it never resolves while the
	 * executor might still dispatch.
	 */
	private async guarded(
		program: PaneInputProgram,
		execute: (execution: PaneInputExecution) => Promise<PaneInputOutcome>,
		entry: Entry,
		paneKey: string,
		deadlineAtMs: number,
	): Promise<PaneInputOutcome> {
		// Re-check here, not only at admission: this program may have waited behind one
		// that then failed to confirm its stop, and overlapping that is the whole hazard.
		const closed = this.quarantined.get(paneKey);
		if (closed) {
			return this.refuse(program, "indeterminate", "backend-failure", `this pane incarnation is quarantined: ${closed}`);
		}
		const controller = new AbortController();
		const running = execute({
			deadlineAtMs,
			signal: controller.signal,
			progress: (accepted) => {
				entry.acceptedThrough = accepted;
			},
		});
		const budget = Math.max(0, deadlineAtMs + this.graceMs - this.now());
		if (await settledWithin(running, budget)) return await running;

		controller.abort();
		if (await settledWithin(running, this.confirmMs)) return await running;

		// Unconfirmed: something may still write, so the incarnation stays closed instead of
		// being handed to a successor. The detail carries the only bound anyone has on what
		// the pane may already have received.
		const detail = `delivery ${program.deliveryId} did not confirm its backend stopped within ${this.confirmMs}ms, after accepting ${entry.acceptedThrough} stage(s)`;
		this.quarantined.set(paneKey, detail);
		void running.catch(() => undefined);
		return this.refuse(program, "indeterminate", "backend-failure", detail);
	}

	private entryKey(program: PaneInputProgram): string {
		return `${this.incarnation}|${paneInputPaneKey(program.incarnation)}|${program.deliveryId}`;
	}

	private settle(entry: Entry): void {
		entry.settled = true;
		entry.settledAtMs = this.now();
	}

	private pruneExpired(): void {
		const cutoff = this.now() - this.retentionMs;
		for (const [key, entry] of this.entries) {
			if (entry.settled && entry.settledAtMs < cutoff) this.entries.delete(key);
		}
	}

	/** Make room by dropping the oldest settled record; an in-flight one is never dropped. */
	private makeRoom(): boolean {
		let victim: string | null = null;
		let oldest = Infinity;
		for (const [key, entry] of this.entries) {
			if (entry.settled && entry.settledAtMs < oldest) {
				oldest = entry.settledAtMs;
				victim = key;
			}
		}
		if (!victim) return false;
		this.entries.delete(victim);
		return true;
	}

	private refuse(
		program: PaneInputProgram,
		status: "not-started" | "indeterminate",
		reason: PaneInputReason,
		detail: string,
		retryableAsNewDelivery = false,
	): PaneInputOutcome {
		const base = {
			deliveryId: program.deliveryId,
			backend: program.incarnation.backend,
			paneId: program.incarnation.paneId,
			executor: this.incarnation,
		};
		return status === "not-started"
			? { ...base, status, reason, retryableAsNewDelivery, detail }
			: { ...base, status, possiblyAcceptedThrough: paneInputStepCount(program), reason, detail };
	}
}

/** Whether `work` settled within `ms`. Never rejects; only bounds a wait. */
async function settledWithin(work: Promise<unknown>, ms: number): Promise<boolean> {
	return await Promise.race([
		work.then(
			() => true,
			() => true,
		),
		new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms)),
	]);
}

/** The one ledger production runs. Tests build their own rather than reaching in here. */
const runtimeLedger = new PaneInputLedger();

export function runPaneInputProgramOnce(
	program: PaneInputProgram,
	execute: (execution: PaneInputExecution) => Promise<PaneInputOutcome>,
): Promise<PaneInputOutcome> {
	return runtimeLedger.run(program, execute);
}
