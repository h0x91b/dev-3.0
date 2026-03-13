/**
 * Nightly integration tests for tmux pane identity and ordering.
 *
 * Our hibernate feature's killSessionMainPaneLast needs to identify the
 * original (main agent) pane reliably, even after the user swaps panes.
 *
 * FINDING: tmux's #{pane_created} format variable does NOT exist in tmux 3.6a
 * (returns empty string). Instead, we use #{pane_pid} which is stable across
 * swaps, and derive creation time from `ps -p <pid> -o lstart=`.
 *
 * These tests verify:
 *   1. pane_pid is stable across swap-pane, select-pane, resize-pane
 *   2. The lowest PID reliably identifies the original (first-created) pane
 *   3. Killing by PID-sorted order (highest first) preserves the original
 *
 * Requires: tmux installed and accessible on PATH.
 */

import { execFileSync, execSync } from "node:child_process";

const SOCKET = `/tmp/dev3-nightly-test-${process.pid}`;
const SESSION = "dev3-nightly-pane";

function tmux(...args: string[]): string {
	return execFileSync(
		"tmux",
		["-S", SOCKET, ...args],
		{ encoding: "utf-8", timeout: 5000 },
	).trim();
}

function tmuxNoFail(...args: string[]): string {
	try {
		return tmux(...args);
	} catch {
		return "";
	}
}

function hasTmux(): boolean {
	try {
		execSync("tmux -V", { encoding: "utf-8", timeout: 2000 });
		return true;
	} catch {
		return false;
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

/** Parse `pane_id|pane_pid` lines into an array of {id, pid} objects. */
function parsePanes(output: string): Array<{ id: string; pid: number }> {
	return output.split("\n").filter(Boolean).map((line) => {
		const [id, pidStr] = line.split("|");
		return { id, pid: Number(pidStr) };
	});
}

/** Get process start time (epoch seconds) from PID using sysctl on macOS. */
function getPidStartTime(pid: number): number {
	try {
		// Use LANG=C to get English ps output regardless of locale
		const out = execSync(`LANG=C ps -p ${pid} -o lstart=`, { encoding: "utf-8", timeout: 2000 }).trim();
		const ts = new Date(out).getTime() / 1000;
		if (!isNaN(ts)) return ts;
		// Fallback: PID ordering (lower PID = older, generally reliable on macOS/Linux)
		return 0;
	} catch {
		return 0;
	}
}

const describeOrSkip = hasTmux() ? describe : describe.skip;

describeOrSkip("tmux pane identity stability", () => {
	beforeEach(() => {
		tmuxNoFail("kill-session", "-t", SESSION);
		tmux("new-session", "-d", "-s", SESSION, "-x", "120", "-y", "30", "sh");
	});

	afterEach(() => {
		tmuxNoFail("kill-session", "-t", SESSION);
		try {
			execSync(`rm -f ${SOCKET}`, { encoding: "utf-8" });
		} catch { /* ignore */ }
	});

	it("pane_pid is a valid process ID", () => {
		const output = tmux("list-panes", "-t", SESSION, "-F", "#{pane_id}|#{pane_pid}");
		const panes = parsePanes(output);
		expect(panes.length).toBe(1);
		expect(panes[0].pid).toBeGreaterThan(0);
	});

	it("pane_pid does not change after swap-pane", async () => {
		tmux("split-window", "-t", SESSION, "-h", "sh");
		await sleep(200);

		const before = parsePanes(
			tmux("list-panes", "-t", SESSION, "-F", "#{pane_id}|#{pane_pid}"),
		);
		expect(before.length).toBe(2);

		// Swap panes
		tmux("swap-pane", "-s", before[0].id, "-t", before[1].id);

		const after = parsePanes(
			tmux("list-panes", "-t", SESSION, "-F", "#{pane_id}|#{pane_pid}"),
		);

		// Build pid→id maps — each PID should still map to the same pane ID
		const afterPidMap = new Map(after.map((p) => [p.pid, p.id]));
		for (const pane of before) {
			expect(afterPidMap.get(pane.pid)).toBe(pane.id);
		}
	});

	it("pane_pid does not change after select-pane", async () => {
		tmux("split-window", "-t", SESSION, "-h", "sh");
		await sleep(100);

		const before = parsePanes(
			tmux("list-panes", "-t", SESSION, "-F", "#{pane_id}|#{pane_pid}"),
		);

		// Select each pane
		tmux("select-pane", "-t", before[0].id);
		tmux("select-pane", "-t", before[1].id);

		const after = parsePanes(
			tmux("list-panes", "-t", SESSION, "-F", "#{pane_id}|#{pane_pid}"),
		);

		expect(after).toEqual(before);
	});

	it("pane_pid does not change after resize-pane", () => {
		tmux("split-window", "-t", SESSION, "-h", "sh");

		const before = parsePanes(
			tmux("list-panes", "-t", SESSION, "-F", "#{pane_id}|#{pane_pid}"),
		);

		tmux("resize-pane", "-t", before[0].id, "-R", "10");

		const after = parsePanes(
			tmux("list-panes", "-t", SESSION, "-F", "#{pane_id}|#{pane_pid}"),
		);

		const afterPidMap = new Map(after.map((p) => [p.pid, p.id]));
		for (const pane of before) {
			expect(afterPidMap.get(pane.pid)).toBe(pane.id);
		}
	});

	it("lowest PID identifies original pane after splits and swaps", async () => {
		// Create 3 more panes with gaps to ensure different PIDs
		tmux("split-window", "-t", SESSION, "-h", "sh");
		await sleep(200);
		tmux("split-window", "-t", SESSION, "-v", "sh");
		await sleep(200);
		tmux("split-window", "-t", SESSION, "-h", "sh");
		await sleep(100);

		const allPanes = parsePanes(
			tmux("list-panes", "-t", SESSION, "-F", "#{pane_id}|#{pane_pid}"),
		);
		expect(allPanes.length).toBe(4);

		// The original pane has the lowest PID (spawned first)
		const original = allPanes.reduce((min, p) => p.pid < min.pid ? p : min);

		// Swap panes aggressively
		if (allPanes.length >= 3) {
			tmux("swap-pane", "-s", allPanes[0].id, "-t", allPanes[2].id);
			tmux("swap-pane", "-s", allPanes[1].id, "-t", allPanes[3].id);
		}

		// Re-read and find lowest PID again
		const afterSwap = parsePanes(
			tmux("list-panes", "-t", SESSION, "-F", "#{pane_id}|#{pane_pid}"),
		);

		const newOriginal = afterSwap.reduce((min, p) => p.pid < min.pid ? p : min);

		// Same pane ID and PID should be identified as the original
		expect(newOriginal.id).toBe(original.id);
		expect(newOriginal.pid).toBe(original.pid);
	});

	it("killing by descending PID preserves the original pane", async () => {
		tmux("split-window", "-t", SESSION, "-h", "sh");
		await sleep(200);
		tmux("split-window", "-t", SESSION, "-v", "sh");
		await sleep(100);

		const allPanes = parsePanes(
			tmux("list-panes", "-t", SESSION, "-F", "#{pane_id}|#{pane_pid}"),
		);
		expect(allPanes.length).toBe(3);

		// Sort by PID descending — kill highest PID first (newest)
		const sorted = [...allPanes].sort((a, b) => b.pid - a.pid);
		const originalId = sorted[sorted.length - 1].id; // lowest PID = original

		// Kill all except the original
		for (let i = 0; i < sorted.length - 1; i++) {
			tmux("kill-pane", "-t", sorted[i].id);
		}

		const remaining = parsePanes(
			tmux("list-panes", "-t", SESSION, "-F", "#{pane_id}|#{pane_pid}"),
		);

		expect(remaining.length).toBe(1);
		expect(remaining[0].id).toBe(originalId);
	});

	it("process start time from ps matches creation order", async () => {
		// Sleep between splits to ensure different start times
		await sleep(1100);
		tmux("split-window", "-t", SESSION, "-h", "sh");

		const panes = parsePanes(
			tmux("list-panes", "-t", SESSION, "-F", "#{pane_id}|#{pane_pid}"),
		);
		expect(panes.length).toBe(2);

		const time1 = getPidStartTime(panes[0].pid);
		const time2 = getPidStartTime(panes[1].pid);

		// First pane should have an older (smaller) start time
		expect(time1).toBeLessThanOrEqual(time2);
		// Both should be valid timestamps
		expect(time1).toBeGreaterThan(0);
		expect(time2).toBeGreaterThan(0);
	});
});

describeOrSkip("tmux pane_created format variable", () => {
	beforeEach(() => {
		tmuxNoFail("kill-session", "-t", SESSION);
		tmux("new-session", "-d", "-s", SESSION, "-x", "120", "-y", "30", "sh");
	});

	afterEach(() => {
		tmuxNoFail("kill-session", "-t", SESSION);
		try {
			execSync(`rm -f ${SOCKET}`, { encoding: "utf-8" });
		} catch { /* ignore */ }
	});

	it("documents whether pane_created is available in the current tmux version", () => {
		const output = tmux("list-panes", "-t", SESSION, "-F", "#{pane_created}");
		const available = output.length > 0 && Number(output) > 0;

		// Log the finding — this test always passes, it just documents the result
		if (available) {
			console.log(`pane_created IS available (tmux ${execSync("tmux -V", { encoding: "utf-8" }).trim()}): ${output}`);
		} else {
			console.log(`pane_created is NOT available (tmux ${execSync("tmux -V", { encoding: "utf-8" }).trim()}). Using pane_pid + ps as fallback.`);
		}

		// This is a documentation test — always passes
		expect(true).toBe(true);
	});
});
