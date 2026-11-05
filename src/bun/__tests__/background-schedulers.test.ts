import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { calls, record } = vi.hoisted(() => {
	const calls: string[] = [];
	return { calls, record: (name: string) => () => { calls.push(name); } };
});

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
vi.mock("../worktree-cleanup-scheduler", () => ({
	startWorktreeCleanupScheduler: record("startWorktreeCleanupScheduler"),
	stopWorktreeCleanupScheduler: record("stopWorktreeCleanupScheduler"),
}));

const { startBackgroundSchedulers, stopBackgroundSchedulers } = await import("../background-schedulers");

const BUN_DIR = join(import.meta.dirname, "..");
const source = (file: string) => readFileSync(join(BUN_DIR, file), "utf8");

// Every `start*Scheduler` exported by a `src/bun/*-scheduler.ts` module, read from disk
// so a new scheduler file fails this suite until it joins the shared start path.
function schedulerExports(prefix: "start" | "stop"): string[] {
	return readdirSync(BUN_DIR)
		.filter((file) => file.endsWith("-scheduler.ts"))
		.flatMap((file) => [...source(file).matchAll(new RegExp(`^export function (${prefix}\\w+Scheduler)\\(`, "gm"))].map((m) => m[1]))
		.sort();
}

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
	startFocusTracker: "reads desktop window focus and HID idle",
	startLoopMonitor: "desktop stall diagnostic",
};

describe("background schedulers", () => {
	beforeEach(() => { calls.length = 0; });

	it("starts every scheduler module in src/bun", () => {
		startBackgroundSchedulers();
		expect([...calls].sort()).toEqual(schedulerExports("start"));
	});

	it("stops every scheduler module in src/bun", () => {
		stopBackgroundSchedulers();
		expect([...calls].sort()).toEqual(schedulerExports("stop"));
	});

	it.each(["index.ts", "headless-entry.ts"])("%s starts them through the shared call only", (file) => {
		const starts = topLevelStarts(file);
		expect(starts.has("startBackgroundSchedulers")).toBe(true);
		expect([...starts].filter((name) => /Scheduler$/.test(name))).toEqual([]);
	});

	it("headless starts everything the desktop starts, except the listed desktop-only parts", () => {
		const headless = topLevelStarts("headless-entry.ts");
		const missing = [...topLevelStarts("index.ts")].filter((name) => !headless.has(name) && !(name in DESKTOP_ONLY));
		expect(missing).toEqual([]);
	});

	it("headless stops the schedulers on shutdown", () => {
		expect(source("headless-entry.ts")).toMatch(/^\tstopBackgroundSchedulers\(\);$/m);
	});
});
