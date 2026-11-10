import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { calls, record } = vi.hoisted(() => {
	const calls: string[] = [];
	return { calls, record: (name: string) => () => { calls.push(name); return Promise.resolve(); } };
});

vi.mock("../focus-tracker", () => ({
	startFocusTracker: record("startFocusTracker"),
	stopFocusTracker: record("stopFocusTracker"),
}));
vi.mock("../automations-scheduler", () => ({
	startAutomationsScheduler: record("startAutomationsScheduler"),
	stopAutomationsScheduler: record("stopAutomationsScheduler"),
}));
vi.mock("../scheduled-launch-scheduler", () => ({
	startScheduledLaunchScheduler: record("startScheduledLaunchScheduler"),
	stopScheduledLaunchScheduler: record("stopScheduledLaunchScheduler"),
}));
vi.mock("../scheduled-message-scheduler", () => ({
	startScheduledMessageScheduler: record("startScheduledMessageScheduler"),
	stopScheduledMessageScheduler: record("stopScheduledMessageScheduler"),
}));
vi.mock("../task-keep-alive-scheduler", () => ({
	startTaskKeepAliveScheduler: record("startTaskKeepAliveScheduler"),
	stopTaskKeepAliveScheduler: record("stopTaskKeepAliveScheduler"),
}));
vi.mock("../log-archive-scheduler", () => ({
	startLogArchiveScheduler: record("startLogArchiveScheduler"),
	stopLogArchiveScheduler: record("stopLogArchiveScheduler"),
}));
vi.mock("../worktree-cleanup-scheduler", () => ({
	startWorktreeCleanupScheduler: record("startWorktreeCleanupScheduler"),
	stopWorktreeCleanupScheduler: record("stopWorktreeCleanupScheduler"),
}));

const { startBackgroundSchedulers, stopBackgroundSchedulers } = await import("../background-schedulers");

const BUN_DIR = join(import.meta.dirname, "..");
const source = (file: string) => readFileSync(join(BUN_DIR, file), "utf8");

// Background jobs that are not `*-scheduler.ts` files but belong in the shared path.
const OTHER_JOBS = { start: ["startFocusTracker"], stop: ["stopFocusTracker"] };

// Every `start*Scheduler` exported by a `src/bun/*-scheduler.ts` module, read from disk
// so a new scheduler file fails this suite until it joins the shared start path.
function expectedJobs(prefix: "start" | "stop"): string[] {
	const schedulers = readdirSync(BUN_DIR)
		.filter((file) => file.endsWith("-scheduler.ts"))
		.flatMap((file) => [...source(file).matchAll(new RegExp(`^export (?:async function |function |const )(${prefix}\\w+Scheduler)\\b`, "gm"))].map((m) => m[1]));
	return [...schedulers, ...OTHER_JOBS[prefix]].sort();
}

const CLOCK_STARTS = () => expectedJobs("start").filter((name) => !OTHER_JOBS.start.includes(name));

// Top-level `startX(` statements of an entry. Both entries boot the whole app, so
// they cannot be imported in a test; their source is the cheapest evidence.
function topLevelStarts(file: string): Set<string> {
	return new Set([...source(file).matchAll(/^(?:await )?(start\w+)\(/gm)].map((m) => m[1]));
}

// What the desktop starts and headless deliberately does not, each with its reason.
const DESKTOP_ONLY: Record<string, string> = {
	startRemoteAccessServerGuarded: "headless starts its own remote server",
	startAutoCheck: "headless updates through startSelfUpdateWatch",
	startDisplayWatch: "watches native window geometry",
	startRendererWatchdog: "watches the desktop renderer's heartbeat",
	startLoopMonitor: "desktop stall diagnostic",
};

describe("background schedulers", () => {
	beforeEach(() => { calls.length = 0; });
	afterEach(async () => {
		await stopBackgroundSchedulers();
		vi.useRealTimers();
	});

	it("starts every scheduler module in src/bun and the focus tracker", () => {
		startBackgroundSchedulers();
		expect([...calls].sort()).toEqual(expectedJobs("start"));
	});

	it("stops every scheduler module in src/bun and the focus tracker", async () => {
		await stopBackgroundSchedulers();
		expect([...calls].sort()).toEqual(expectedJobs("stop"));
	});

	it("keeps stopping the rest, and flushes focus time, when one stop throws", async () => {
		const automations = await import("../automations-scheduler");
		vi.spyOn(automations, "stopAutomationsScheduler").mockImplementationOnce(() => { throw new Error("boom"); });
		await stopBackgroundSchedulers();
		expect([...calls].sort()).toEqual(expectedJobs("stop").filter((name) => name !== "stopAutomationsScheduler"));
	});

	describe("yielding to another dev3 process", () => {
		it("runs only the focus tracker while a peer is alive", () => {
			startBackgroundSchedulers({ yieldToPeers: true, hasPeers: () => true });
			expect(calls).toEqual(["startFocusTracker"]);
		});

		it("takes the schedulers over when the peer exits, and hands them back when one appears", () => {
			vi.useFakeTimers();
			let peers = true;
			startBackgroundSchedulers({ yieldToPeers: true, hasPeers: () => peers });
			calls.length = 0;
			peers = false;
			vi.advanceTimersByTime(10_000);
			expect([...calls].sort()).toEqual(CLOCK_STARTS());
			calls.length = 0;
			vi.advanceTimersByTime(10_000);
			expect(calls, "a steady state starts nothing twice").toEqual([]);
			peers = true;
			vi.advanceTimersByTime(10_000);
			expect(calls.every((name) => name.startsWith("stop") && name !== "stopFocusTracker")).toBe(true);
			expect(calls).toHaveLength(CLOCK_STARTS().length);
		});

		it("treats a failing peer probe as a peer, so nothing can fire twice", () => {
			startBackgroundSchedulers({ yieldToPeers: true, hasPeers: () => { throw new Error("EACCES"); } });
			expect(calls).toEqual(["startFocusTracker"]);
		});

		it("is what headless asks for, and the desktop does not", () => {
			expect(source("headless-entry.ts")).toMatch(/^startBackgroundSchedulers\(\{ yieldToPeers: true \}\);$/m);
			expect(source("index.ts")).toMatch(/^startBackgroundSchedulers\(\);$/m);
		});
	});

	it.each(["index.ts", "headless-entry.ts"])("%s starts them through the shared call only", (file) => {
		const starts = topLevelStarts(file);
		expect(starts.has("startBackgroundSchedulers")).toBe(true);
		const shared = new Set(expectedJobs("start"));
		expect([...starts].filter((name) => shared.has(name))).toEqual([]);
	});

	it("headless starts everything the desktop starts, except the listed desktop-only parts", () => {
		const headless = topLevelStarts("headless-entry.ts");
		const missing = [...topLevelStarts("index.ts")].filter((name) => !headless.has(name) && !(name in DESKTOP_ONLY));
		expect(missing).toEqual([]);
	});

	it("headless drops the foreground flag when its last browser leaves", () => {
		expect(source("headless-entry.ts")).toMatch(/onLastRpcClientGone: \(\) => setAppForeground\(false\)/);
	});

	it("headless stops the schedulers on shutdown", () => {
		expect(source("headless-entry.ts")).toMatch(/^\tconst focusFlushed = stopBackgroundSchedulers\(\);$/m);
	});
});
