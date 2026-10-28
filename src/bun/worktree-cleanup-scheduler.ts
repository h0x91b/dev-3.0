import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Worker } from "node:worker_threads";
import { formatBytes } from "../cli/commands/doctor-worktrees";
import { withFileLock } from "./file-lock";
import { createLogger } from "./logger";
import { DEV3_HOME } from "./paths";
import { loadSettings } from "./settings";
import type { WorktreeCleanupResult } from "./worktree-cleanup-job";

const log = createLogger("worktree-cleanup");

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;
/** Never right after launch: startup is busy enough, and a restart loop must not re-run it. */
export const INITIAL_DELAY_MS = HOUR_MS;
const CHECK_INTERVAL_MS = HOUR_MS;
const WORKER_TIMEOUT_MS = 2 * HOUR_MS;

/**
 * Shared by every installed version on the machine. `lastStartedAt` is written
 * BEFORE the run, under a file lock, so a second version (or a crash loop) sees
 * the claim and skips instead of pruning the same tree concurrently.
 */
export interface WorktreeCleanupState {
	lastStartedAt?: string;
	lastFinishedAt?: string;
	lastResult?: { freedBytes: number; removedDirs: number; failed: number; scannedDirs: number };
	lastError?: string;
}

export interface WorktreeCleanupDeps {
	now: () => number;
	enabled: () => Promise<boolean>;
	/** False when the worker bundle is missing — the scan must never run on the host thread. */
	canRun: () => boolean;
	/** Atomically read-modify-write the shared state; returns what `fn` returned. */
	withState: <T>(fn: (state: WorktreeCleanupState) => { next?: WorktreeCleanupState; result: T }) => Promise<T>;
	run: () => Promise<WorktreeCleanupResult>;
}

export function cleanupDue(state: WorktreeCleanupState, now: number): boolean {
	const last = state.lastStartedAt ? Date.parse(state.lastStartedAt) : Number.NaN;
	if (!Number.isFinite(last)) return true;
	// A stamp from the future (clock moved back) must not block cleanup forever.
	return now - last >= DAY_MS || last - now > DAY_MS;
}

/** One check: run the cleanup when it is enabled and no version ran it in the last 24 h. */
export async function checkWorktreeCleanup(deps: WorktreeCleanupDeps): Promise<"ran" | "not-due" | "disabled" | "unavailable" | "failed"> {
	if (!(await deps.enabled())) return "disabled";
	if (!deps.canRun()) return "unavailable";
	const startedAt = deps.now();
	const claimed = await deps.withState((state) =>
		cleanupDue(state, startedAt)
			? { next: { ...state, lastStartedAt: new Date(startedAt).toISOString() }, result: true }
			: { result: false },
	);
	if (!claimed) return "not-due";

	try {
		const result = await deps.run();
		const finishedAt = deps.now();
		await deps.withState((state) => ({
			next: {
				...state,
				lastFinishedAt: new Date(finishedAt).toISOString(),
				lastResult: {
					freedBytes: result.freedBytes,
					removedDirs: result.removedDirs,
					failed: result.failed,
					scannedDirs: result.scannedDirs,
				},
				lastError: undefined,
			},
			result: undefined,
		}));
		log.info("Daily worktree cleanup finished", {
			freed: formatBytes(result.freedBytes),
			removedDirs: result.removedDirs,
			failed: result.failed,
			skipped: result.skipped,
			scannedDirs: result.scannedDirs,
			onDiskBefore: formatBytes(result.bytesBefore),
			durationMs: finishedAt - startedAt,
			gzipDiffs: result.afterPrune,
			removed: result.outcomes.map((o) => `${o.projectName ?? "?"}/${o.shortId} ${o.action} ${formatBytes(o.freedBytes)}`),
		});
		return "ran";
	} catch (err) {
		log.error("Daily worktree cleanup failed", { error: String(err) });
		await deps.withState((state) => ({ next: { ...state, lastError: String(err) }, result: undefined })).catch(() => {});
		return "failed";
	}
}

const STATE_FILE = `${DEV3_HOME}/worktree-cleanup.json`;
let workerPath: string | null = null;
let initialTimer: ReturnType<typeof setTimeout> | null = null;
let interval: ReturnType<typeof setInterval> | null = null;
let checkInFlight = false;

export function configureWorktreeCleanupWorker(path: string | null): void {
	workerPath = path;
}

function readState(): WorktreeCleanupState {
	try {
		const parsed = JSON.parse(readFileSync(STATE_FILE, "utf8"));
		return parsed && typeof parsed === "object" ? (parsed as WorktreeCleanupState) : {};
	} catch {
		return {};
	}
}

function runInWorker(path: string): Promise<WorktreeCleanupResult> {
	return new Promise((resolve, reject) => {
		const worker = new Worker(path, { workerData: { dev3Home: DEV3_HOME } });
		let settled = false;
		const finish = (settle: () => void) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			void worker.terminate().catch(() => {});
			settle();
		};
		const timer = setTimeout(() => finish(() => reject(new Error("worktree cleanup timed out"))), WORKER_TIMEOUT_MS);
		worker.on("message", (message: { ok: boolean; result?: WorktreeCleanupResult; error?: string }) => {
			finish(() => (message.ok && message.result ? resolve(message.result) : reject(new Error(message.error ?? "worktree cleanup worker failed"))));
		});
		worker.on("error", (error) => finish(() => reject(error)));
		worker.on("exit", (code) => finish(() => reject(new Error(`worktree cleanup worker exited with code ${code}`))));
	});
}

const realDeps: WorktreeCleanupDeps = {
	now: () => Date.now(),
	enabled: async () => (await loadSettings()).autoCleanupTaskHistory !== false,
	canRun: () => workerPath !== null && existsSync(workerPath),
	withState: (fn) =>
		withFileLock(STATE_FILE, async () => {
			const { next, result } = fn(readState());
			if (next) {
				mkdirSync(dirname(STATE_FILE), { recursive: true });
				writeFileSync(STATE_FILE, `${JSON.stringify(next, null, 2)}\n`);
			}
			return result;
		}),
	run: () => runInWorker(workerPath!),
};

async function tick(deps: WorktreeCleanupDeps): Promise<void> {
	if (checkInFlight) return;
	checkInFlight = true;
	try {
		const outcome = await checkWorktreeCleanup(deps);
		if (outcome === "unavailable") log.warn("Worktree cleanup worker missing; skipping daily cleanup", { workerPath });
	} catch (err) {
		log.error("Worktree cleanup check failed", { error: String(err) });
	} finally {
		checkInFlight = false;
	}
}

/**
 * Daily `dev3 doctor --worktrees --prune-older-than 14d`, never at launch: the first
 * check waits {@link INITIAL_DELAY_MS}, later ones run hourly against the persisted
 * last run. Sanctioned in decisions/2026/10/28/daily-worktree-cleanup.md.
 */
export function startWorktreeCleanupScheduler(deps: WorktreeCleanupDeps = realDeps): void {
	if (initialTimer || interval) return;
	log.info("Worktree cleanup scheduler started", { initialDelayMs: INITIAL_DELAY_MS, checkMs: CHECK_INTERVAL_MS });
	initialTimer = setTimeout(() => {
		initialTimer = null;
		void tick(deps);
		interval = setInterval(() => void tick(deps), CHECK_INTERVAL_MS);
	}, INITIAL_DELAY_MS);
}

export function stopWorktreeCleanupScheduler(): void {
	if (initialTimer) clearTimeout(initialTimer);
	if (interval) clearInterval(interval);
	initialTimer = null;
	interval = null;
}
