import * as data from "./data";
import { createLogger } from "./logger";
import { getActiveContext, isAppForeground } from "./rpc-handlers/shared";
import { getUserIdleSeconds } from "./user-activity";

const log = createLogger("focus-tracker");

/** How often the tracker samples attention. */
const TICK_MS = 15_000;
/** Idle-past-this (HID input silence, seconds) means the user has stepped away. */
const IDLE_THRESHOLD_SEC = 60;
/** Flush the in-memory buffer to disk every N ticks (~1 min at the default tick). */
const FLUSH_EVERY_TICKS = 4;
/**
 * Cap the credit for a single tick. A long gap between ticks means the machine
 * slept or the event loop was blocked — the user wasn't attending the whole time,
 * so never credit more than two nominal ticks (the idle gate usually catches this
 * on wake anyway, but this bounds the pathological case).
 */
const MAX_CREDIT_PER_TICK_MS = TICK_MS * 2;

/** A snapshot of the signals that decide whether the current interval is attention. */
export interface FocusSample {
	/** Whether the app window has key focus (renderer-reported). */
	foreground: boolean;
	/** Seconds since last HID input; null when unknown (non-macOS). */
	idleSeconds: number | null;
	/** The task the user is looking at, or null. */
	activeTaskId: string | null;
	/** That task's project, or null. */
	activeProjectId: string | null;
}

/**
 * Pure decision: does the elapsed interval count as attention on the active task?
 * Credits when the app is foregrounded, a task is on-screen, and the user is not
 * idle past the threshold. Idle unknown (null, off-macOS) is treated as active —
 * foreground alone is the best available signal there.
 */
export function shouldCreditFocus(
	sample: FocusSample,
	idleThresholdSec: number = IDLE_THRESHOLD_SEC,
): { taskId: string; projectId: string } | null {
	if (!sample.foreground) return null;
	if (!sample.activeTaskId || !sample.activeProjectId) return null;
	if (sample.idleSeconds != null && sample.idleSeconds > idleThresholdSec) return null;
	return { taskId: sample.activeTaskId, projectId: sample.activeProjectId };
}

/** Injectable dependencies — real ones in production, fakes in tests. */
export interface FocusTrackerDeps {
	now: () => number;
	isForeground: () => boolean;
	getActiveContext: () => { projectId: string | null; taskId: string | null };
	getIdleSeconds: () => Promise<number | null>;
	/** Persist accumulated attention for one task. */
	addFocusMs: (projectId: string, taskId: string, ms: number) => Promise<void>;
	tickMs?: number;
	idleThresholdSec?: number;
	flushEveryTicks?: number;
	maxCreditPerTickMs?: number;
}

/**
 * Accumulates real UI attention time per task from the foreground + idle + active-
 * context signals and flushes it to `Task.focusMs`. Kept as a class with injected
 * deps so the tick/flush logic is unit-testable without timers or disk. See
 * decision record on time tracking.
 */
export class FocusTracker {
	private timer: ReturnType<typeof setInterval> | null = null;
	private lastTickAt: number | null = null;
	private tickCount = 0;
	private tickInFlight = false;
	private flushInFlight = false;
	/** taskId → pending (unflushed) attention. */
	private pending = new Map<string, { projectId: string; ms: number }>();

	constructor(private readonly deps: FocusTrackerDeps) {}

	private get tickMs(): number {
		return this.deps.tickMs ?? TICK_MS;
	}

	start(): void {
		if (this.timer) return;
		this.lastTickAt = this.deps.now();
		this.timer = setInterval(() => void this.tick(), this.tickMs);
		log.info("Focus tracker started", { tickMs: this.tickMs });
	}

	stop(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
		void this.flush();
	}

	/** One sampling step. Public for tests — normally driven by the interval timer. */
	async tick(): Promise<void> {
		if (this.tickInFlight) return;
		this.tickInFlight = true;
		try {
			const now = this.deps.now();
			const maxCredit = this.deps.maxCreditPerTickMs ?? MAX_CREDIT_PER_TICK_MS;
			const elapsed = this.lastTickAt == null ? 0 : Math.min(Math.max(0, now - this.lastTickAt), maxCredit);
			this.lastTickAt = now;

			if (elapsed > 0) {
				const idleSeconds = await this.deps.getIdleSeconds().catch(() => null);
				const ctx = this.deps.getActiveContext();
				const credit = shouldCreditFocus(
					{
						foreground: this.deps.isForeground(),
						idleSeconds,
						activeTaskId: ctx.taskId,
						activeProjectId: ctx.projectId,
					},
					this.deps.idleThresholdSec ?? IDLE_THRESHOLD_SEC,
				);
				if (credit) {
					const entry = this.pending.get(credit.taskId) ?? { projectId: credit.projectId, ms: 0 };
					entry.ms += elapsed;
					entry.projectId = credit.projectId;
					this.pending.set(credit.taskId, entry);
				}
			}

			this.tickCount += 1;
			if (this.tickCount % (this.deps.flushEveryTicks ?? FLUSH_EVERY_TICKS) === 0) {
				await this.flush();
			}
		} finally {
			this.tickInFlight = false;
		}
	}

	/** Persist and clear the pending buffer. Public for tests / shutdown. */
	async flush(): Promise<void> {
		if (this.flushInFlight || this.pending.size === 0) return;
		this.flushInFlight = true;
		const batch = [...this.pending.entries()];
		this.pending.clear();
		try {
			for (const [taskId, { projectId, ms }] of batch) {
				try {
					await this.deps.addFocusMs(projectId, taskId, ms);
				} catch (err) {
					log.warn("Failed to flush focus time (dropped)", { taskId: taskId.slice(0, 8), error: String(err) });
				}
			}
		} finally {
			this.flushInFlight = false;
		}
	}
}

let singleton: FocusTracker | null = null;

/** Production deps: real clock, live foreground/context/idle probes, disk writer. */
function defaultDeps(): FocusTrackerDeps {
	return {
		now: () => Date.now(),
		isForeground: isAppForeground,
		getActiveContext,
		getIdleSeconds: getUserIdleSeconds,
		addFocusMs: async (projectId, taskId, ms) => {
			const project = await data.getProject(projectId);
			await data.addTaskFocusMs(project, taskId, ms);
		},
	};
}

/** Start the process-wide focus tracker. Idempotent. */
export function startFocusTracker(): void {
	if (singleton) return;
	singleton = new FocusTracker(defaultDeps());
	singleton.start();
}

/** Stop the process-wide focus tracker and flush any pending attention. */
export function stopFocusTracker(): void {
	singleton?.stop();
	singleton = null;
}
