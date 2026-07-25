/**
 * The tmux port's mapping onto the typed tmux client: which client method each
 * product operation uses and with which arguments. Keeps tmux grammar assertions
 * in one place instead of leaking into the contract tests.
 */

import { describe, expect, it, vi } from "vitest";
import type { TmuxClient } from "../../tmux";
import { PANE_SWITCHER_FORMAT } from "../../tmux/formats";
import { tmuxBackendPort } from "../tmux-port";

function stubClient() {
	return {
		hasSession: vi.fn(async () => true),
		newSessionDetached: vi.fn(async () => ({ stderr: "" })),
		listPanes: vi.fn(async () => [{ paneId: "%1", active: true }]),
		activePaneId: vi.fn(async () => "%1"),
		splitWindow: vi.fn(async () => ({ paneId: "%2", stderr: "" })),
		selectPane: vi.fn(async () => undefined),
		sendKeys: vi.fn(async () => undefined),
		resizeWindow: vi.fn(async () => undefined),
		capturePane: vi.fn(async () => "text"),
		killPane: vi.fn(async () => undefined),
		killSession: vi.fn(async () => undefined),
	};
}

function portFor(client: ReturnType<typeof stubClient>) {
	return tmuxBackendPort(client as unknown as TmuxClient);
}

describe("tmuxBackendPort", () => {
	it("creates a detached session with the launch spec", async () => {
		const client = stubClient();
		await portFor(client).newSessionDetached("task-a", { cwd: "/w", env: { A: "1" }, command: "sh" });
		expect(client.newSessionDetached).toHaveBeenCalledWith({
			sessionName: "task-a",
			cwd: "/w",
			env: { A: "1" },
			command: "sh",
		});
	});

	it("lists every pane of the session through the typed pane format", async () => {
		const client = stubClient();
		await expect(portFor(client).listPanes("task-a")).resolves.toEqual([
			{ paneId: "%1", active: true },
		]);
		expect(client.listPanes).toHaveBeenCalledWith(PANE_SWITCHER_FORMAT, {
			target: "task-a",
			scope: "session",
		});
	});

	it("splits vertically and returns the new pane id", async () => {
		const client = stubClient();
		await expect(portFor(client).splitPane("%1", { cwd: "/w" })).resolves.toBe("%2");
		expect(client.splitWindow).toHaveBeenCalledWith(
			expect.objectContaining({ target: "%1", orientation: "vertical", printPaneId: true, cwd: "/w" }),
		);
	});

	it("fails when tmux reports no pane id for a split", async () => {
		const client = stubClient();
		client.splitWindow.mockResolvedValue({ paneId: null as never, stderr: "" });
		await expect(portFor(client).splitPane("%1", { cwd: "/w" })).rejects.toThrow(/no pane id/);
	});

	it("writes input literally so control bytes are not read as key names", async () => {
		const client = stubClient();
		await portFor(client).writePane("%1", "echo hi\r");
		expect(client.sendKeys).toHaveBeenCalledWith("%1", ["echo hi\r"], { literal: true });
	});

	it("resizes the session's window", async () => {
		const client = stubClient();
		await portFor(client).resize("task-a", 120, 40);
		expect(client.resizeWindow).toHaveBeenCalledWith({ target: "task-a", cols: 120, rows: 40 });
	});

	it("captures the visible pane by default and bounded history on request", async () => {
		const client = stubClient();
		await portFor(client).capturePane("%1", false);
		expect(client.capturePane).toHaveBeenCalledWith({ target: "%1", startLine: undefined });
		await portFor(client).capturePane("%1", true);
		expect(client.capturePane).toHaveBeenCalledWith({ target: "%1", startLine: -3000 });
	});

	it("passes best-effort teardown through to tmux", async () => {
		const client = stubClient();
		await portFor(client).killPane("%1", true);
		await portFor(client).killSession("task-a", false);
		expect(client.killPane).toHaveBeenCalledWith("%1", { bestEffort: true });
		expect(client.killSession).toHaveBeenCalledWith("task-a", { bestEffort: false });
	});
});
