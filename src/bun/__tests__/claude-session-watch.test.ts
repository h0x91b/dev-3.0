import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeSessionWatches, type ClaudeIdleEvent } from "../claude-session-watch";

const roots: string[] = [];
const watchers: ClaudeSessionWatches[] = [];
afterEach(() => {
	for (const watcher of watchers.splice(0)) watcher.close();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
	const directory = mkdtempSync(join(tmpdir(), "claude-idle-"));
	roots.push(directory);
	const onIdle = vi.fn(async (_event: ClaudeIdleEvent) => {});
	const watcher = new ClaudeSessionWatches(() => true);
	watchers.push(watcher);
	const input = { projectId: "project", taskId: "task", paneId: "%1", sessionId: "session", directory, cwd: directory };
	const record = { pid: 123, sessionId: "session", cwd: directory, startedAt: 1, kind: "interactive", entrypoint: "cli", status: "busy", statusUpdatedAt: 10 };
	const write = (patch = {}) => writeFileSync(join(directory, "123.json"), JSON.stringify({ ...record, ...patch }));
	write();
	return { watcher, onIdle, input, write };
}

describe("Claude's native session idle event", () => {
	it("reports Escape after busy (before any assistant token or tool hook) once, invalidated by the next prompt", async () => {
		const { watcher, onIdle, input, write } = fixture();
		watcher.observe(input, onIdle);
		write({ status: "idle", statusUpdatedAt: 20 });
		await watcher.check(input.taskId, input.paneId);
		expect(onIdle).toHaveBeenCalledTimes(1);
		await watcher.check(input.taskId, input.paneId);
		expect(onIdle).toHaveBeenCalledTimes(1);

		// A subsequent prompt invalidates the queued idle event.
		const event = onIdle.mock.calls[0]![0];
		expect(watcher.isCurrentIdle(event)).toBe(true);
		write({ status: "busy", statusUpdatedAt: 30 });
		watcher.observe(input, onIdle);
		expect(watcher.isCurrentIdle(event)).toBe(false);
	});

	it("does not treat a dismissed UI, a pending tool cancellation, or an exited/malformed session as idle", async () => {
		const { watcher, onIdle, input, write } = fixture();
		watcher.observe(input, onIdle);
		write({ updatedAt: 50 });
		await watcher.check(input.taskId, input.paneId);
		write({ kind: "sdk", status: "idle", statusUpdatedAt: 20 });
		await watcher.check(input.taskId, input.paneId);
		expect(onIdle).not.toHaveBeenCalled();
	});

	it("rejects process replacement without adopting its later idle edge", async () => {
		const { watcher, onIdle, input, write } = fixture();
		watcher.observe(input, onIdle);
		write({ startedAt: 2, statusUpdatedAt: 30 });
		await watcher.check(input.taskId, input.paneId);
		write({ startedAt: 2, status: "idle", statusUpdatedAt: 40 });
		await watcher.check(input.taskId, input.paneId);
		expect(onIdle).not.toHaveBeenCalled();
	});

	it("waits until all observed Claude panes are idle, never hiding an unobserved one", async () => {
		const { watcher, onIdle, input, write } = fixture();
		watcher.observe(input, onIdle);
		const peer = { pid: 124, sessionId: "peer", cwd: input.cwd, startedAt: 1, kind: "interactive", entrypoint: "cli", status: "busy", statusUpdatedAt: 10 };
		writeFileSync(join(input.directory, "124.json"), JSON.stringify(peer));
		watcher.observe({ ...input, paneId: "%2", sessionId: "peer" }, onIdle);
		write({ status: "idle", statusUpdatedAt: 20 });
		await watcher.check(input.taskId, input.paneId);
		const panes = [{ paneId: "%1", sessionId: "session" }, { paneId: "%2", sessionId: "peer" }];
		expect(watcher.allIdle("task", [panes[0]])).toBe(true);
		expect(watcher.allIdle("task", [...panes, { paneId: "%3", sessionId: "unobserved" }])).toBe(false);
		expect(watcher.allIdle("task", panes)).toBe(false);
		writeFileSync(join(input.directory, "124.json"), JSON.stringify({ ...peer, status: "idle", statusUpdatedAt: 20 }));
		await watcher.check(input.taskId, "%2");
		expect(watcher.allIdle("task", panes)).toBe(true);
	});
});
