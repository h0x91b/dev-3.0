import { mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { home, socketDir } = vi.hoisted(() => {
	const { mkdirSync, mkdtempSync } = require("node:fs") as typeof import("node:fs");
	const { tmpdir } = require("node:os") as typeof import("node:os");
	const { join } = require("node:path") as typeof import("node:path");
	const home = mkdtempSync(join(tmpdir(), "dev3-agent-fence-"));
	const socketDir = join(home, "tmux-501");
	mkdirSync(socketDir, { recursive: true });
	return { home, socketDir };
});

vi.mock("../paths", () => ({ DEV3_HOME: home }));
vi.mock("../tmux", () => ({
	DEFAULT_TMUX_SOCKET: "dev3",
	tmux: { closeAgentFence: vi.fn(), listAgentFences: vi.fn() },
}));
vi.mock("../tmux/socket-files", () => ({ tmuxSocketDir: () => socketDir }));
vi.mock("../tmux/socket-sweep", () => ({ probeSocketLiveness: vi.fn(async () => "listening") }));
vi.mock("../logger", () => ({
	createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { tmux } from "../tmux";
import { probeSocketLiveness } from "../tmux/socket-sweep";
import {
	AGENT_FENCE_ORPHAN_ACK_MS,
	agentFenceCloseRequested,
	onAgentFenceLateClose,
	parseAgentFenceCloseRequest,
	socketNameForPath,
	sweepAgentFenceRequests,
} from "../agent-fence";
import { agentFenceIndexDir } from "../agent-fence-paths";

const TASK = "0123abcd-0000-4000-8000-000000000000";
const index = () => agentFenceIndexDir();
const request = (id: string, pane = "%3", socket = join(socketDir, "dev3"), code = "143") =>
	writeFileSync(join(index(), `${id}.close`), `${id} ${pane} ${socket} ${code} ${TASK}\n`);

beforeEach(() => {
	rmSync(index(), { recursive: true, force: true });
	mkdirSync(index(), { recursive: true });
	vi.mocked(tmux.closeAgentFence).mockReset();
	vi.mocked(tmux.listAgentFences).mockReset();
	vi.mocked(probeSocketLiveness).mockResolvedValue("listening");
	onAgentFenceLateClose(null);
});
afterEach(() => onAgentFenceLateClose(null));

describe("parseAgentFenceCloseRequest", () => {
	it("accepts exactly what the wrapper writes, named by its own launch id", () => {
		expect(parseAgentFenceCloseRequest("L1.close", `L1 %3 /tmp/tmux-501/dev3 143 ${TASK}\n`)).toEqual({
			launchId: "L1",
			paneId: "%3",
			socketPath: "/tmp/tmux-501/dev3",
			exitCode: 143,
			taskId: TASK,
		});
	});

	it.each([
		["L1.close", "L2 %3 /tmp/s 1"], // content names another launch
		["L1.close", "L1 3 /tmp/s 1"], // not a pane id
		["L1.close", "L1 %3 relative/s 1"], // not an absolute socket path
		["L1.close", "L1 %3 /tmp/s 256"], // exit code out of range
		["L1.close", "L1 %3 /tmp/s 01"],
		["bad_name.close", "bad_name %3 /tmp/s 1"],
		["L1.txt", "L1 %3 /tmp/s 1"],
	])("rejects %s with %j", (name, content) => {
		expect(parseAgentFenceCloseRequest(name, content)).toBeNull();
	});
});

describe("socketNameForPath", () => {
	it("matches this user's socket directory by realpath and returns the -L name", () => {
		expect(socketNameForPath(join(socketDir, "dev3"), socketDir)).toBe("dev3");
		expect(socketNameForPath(join(socketDir, "..", "tmux-501", "dev3"), socketDir)).toBe("dev3");
		expect(socketNameForPath("/somewhere/else/dev3", socketDir)).toBeNull();
	});
});

describe("sweepAgentFenceRequests", () => {
	it("closes, acks with the stored nonce, and tells the late-close listener", async () => {
		request("L1");
		vi.mocked(tmux.closeAgentFence).mockResolvedValue({ kind: "closed", nonce: "0123456789abcdef" });
		const heard = vi.fn();
		onAgentFenceLateClose(heard);
		const report = await sweepAgentFenceRequests();
		expect(tmux.closeAgentFence).toHaveBeenCalledWith({ pane: "%3", launchId: "L1", exitCode: 143, socket: "dev3" });
		expect(report.closed).toEqual(["L1"]);
		expect(readFileSync(join(index(), "L1.closed-ack"), "utf8")).toBe("L1 closed:L1:143 0123456789abcdef\n");
		expect(heard).toHaveBeenCalledWith(expect.objectContaining({ launchId: "L1", taskId: TASK }));
		// No tmp file is left behind by the atomic write.
		expect(readdirSync(index()).sort()).toEqual(["L1.close", "L1.closed-ack"]);
	});

	// After the handover a second sentinel would land in the user's live shell line.
	it("never touches a request that already has an ack", async () => {
		request("L1");
		writeFileSync(join(index(), "L1.closed-ack"), "L1 closed:L1:143 0123456789abcdef\n");
		const report = await sweepAgentFenceRequests();
		expect(tmux.closeAgentFence).not.toHaveBeenCalled();
		expect(report.kept).toEqual(["L1"]);
	});

	it("skips a request for a tmux server outside this user's socket directory", async () => {
		request("L1", "%3", "/elsewhere/tmux-9/dev3");
		const report = await sweepAgentFenceRequests();
		expect(tmux.closeAgentFence).not.toHaveBeenCalled();
		expect(report.kept).toEqual(["L1"]);
	});

	it("removes its own request once the server shows no pane of that launch", async () => {
		request("L1");
		vi.mocked(tmux.closeAgentFence).mockResolvedValue({ kind: "not-this-launch", fence: "" });
		vi.mocked(tmux.listAgentFences).mockResolvedValue([{ paneId: "%7", agentFence: "open:L9" }]);
		const report = await sweepAgentFenceRequests();
		expect(report.removed).toEqual(["L1"]);
		expect(readdirSync(index())).toEqual([]);
	});

	it("keeps it while a pane of that launch still exists, or when the server cannot answer", async () => {
		request("L1");
		vi.mocked(tmux.closeAgentFence).mockResolvedValue({ kind: "failed", detail: "boom" });
		vi.mocked(tmux.listAgentFences).mockResolvedValueOnce([{ paneId: "%3", agentFence: "open:L1" }]);
		expect((await sweepAgentFenceRequests()).kept).toEqual(["L1"]);
		vi.mocked(tmux.listAgentFences).mockRejectedValueOnce(new Error("timeout"));
		vi.mocked(probeSocketLiveness).mockResolvedValueOnce("unknown");
		expect((await sweepAgentFenceRequests()).kept).toEqual(["L1"]);
		expect(readdirSync(index())).toEqual(["L1.close"]);
	});

	it("removes it when the socket has no server behind it at all", async () => {
		request("L1");
		vi.mocked(tmux.closeAgentFence).mockResolvedValue({ kind: "failed", detail: "no server" });
		vi.mocked(tmux.listAgentFences).mockRejectedValue(new Error("no server"));
		vi.mocked(probeSocketLiveness).mockResolvedValue("dead");
		expect((await sweepAgentFenceRequests()).removed).toEqual(["L1"]);
	});

	it("never deletes a file this protocol did not write", async () => {
		writeFileSync(join(index(), "README.txt"), "x");
		writeFileSync(join(index(), "bad_name.close"), "x");
		writeFileSync(join(index(), "L2.close"), "L3 %3 /tmp/s 1\n");
		vi.mocked(tmux.listAgentFences).mockResolvedValue([]);
		await sweepAgentFenceRequests();
		expect(tmux.closeAgentFence).not.toHaveBeenCalled();
		expect(readdirSync(index()).sort()).toEqual(["L2.close", "README.txt", "bad_name.close"]);
	});

	it("collects an ack without a request only once it is old", async () => {
		const ack = join(index(), "L5.closed-ack");
		writeFileSync(ack, "L5 closed:L5:0 0123456789abcdef\n");
		expect((await sweepAgentFenceRequests()).removed).toEqual([]);
		const old = (Date.now() - AGENT_FENCE_ORPHAN_ACK_MS - 1000) / 1000;
		utimesSync(ack, old, old);
		expect((await sweepAgentFenceRequests()).removed).toEqual(["L5"]);
		expect(readdirSync(index())).toEqual([]);
	});
});

describe("agentFenceCloseRequested", () => {
	it("is true only for a pending request, and kicks its close", async () => {
		expect(await agentFenceCloseRequested("L1")).toBe(false);
		request("L1");
		vi.mocked(tmux.closeAgentFence).mockResolvedValue({ kind: "closed", nonce: "0123456789abcdef" });
		expect(await agentFenceCloseRequested("L1")).toBe(true);
		await vi.waitFor(() => expect(tmux.closeAgentFence).toHaveBeenCalledTimes(1));
		expect(await agentFenceCloseRequested("../x")).toBe(false);
	});
});
