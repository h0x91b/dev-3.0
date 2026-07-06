import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PortInfo } from "../../../shared/types";

// vi.mock factories are hoisted above imports, so the mock fns must be created
// inside vi.hoisted (not as plain top-level consts).
const h = vi.hoisted(() => ({
	findPortHolders: vi.fn<(ports: number[]) => Promise<PortInfo[]>>(),
	getDescendantPids: vi.fn<(pid: number) => Promise<number[]>>(),
	waitForPortsFree: vi.fn<() => Promise<PortInfo[]>>(),
	loadSettings: vi.fn<() => Promise<Record<string, unknown>>>(),
	spawnMock: vi.fn(),
	fs: {
		existsSync: vi.fn(() => false),
		readFileSync: vi.fn(() => ""),
		writeFileSync: vi.fn(),
		rmSync: vi.fn(),
		mkdirSync: vi.fn(),
	},
}));

vi.mock("../../port-scanner", () => ({
	findPortHolders: h.findPortHolders,
	getDescendantPids: h.getDescendantPids,
	waitForPortsFree: h.waitForPortsFree,
}));
vi.mock("../../settings", () => ({ loadSettings: h.loadSettings }));
vi.mock("../../spawn", () => ({ spawn: h.spawnMock }));
vi.mock("../../paths", () => ({ DEV3_HOME: "/tmp/dev3-pxpipe-test" }));
vi.mock("node:fs", () => h.fs);

const PORT = 47821;

// Route `which npx` and `npx -y pxpipe-proxy` through the same spawn mock.
function stubNpx(available: boolean) {
	h.spawnMock.mockImplementation((cmd: string[]) => {
		if (cmd[0] === "which") {
			return { stdout: available ? "/usr/bin/npx\n" : "", exited: Promise.resolve(available ? 0 : 1) };
		}
		return { pid: 4242, unref: () => {}, stdout: "", exited: new Promise(() => {}) };
	});
}

import { getPxpipeProxyStatus, startPxpipeProxy, stopPxpipeProxy } from "../pxpipe-proxy";

beforeEach(() => {
	vi.clearAllMocks();
	h.findPortHolders.mockResolvedValue([]);
	h.getDescendantPids.mockResolvedValue([]);
	h.waitForPortsFree.mockResolvedValue([]);
	h.loadSettings.mockResolvedValue({ pxpipeProxyEnabled: true });
	h.fs.existsSync.mockReturnValue(false);
	h.fs.readFileSync.mockReturnValue("");
	stubNpx(true);
});

describe("getPxpipeProxyStatus", () => {
	it("reports npx availability from the toggle and PATH", async () => {
		const s = await getPxpipeProxyStatus();
		expect(s.enabled).toBe(true);
		expect(s.npxAvailable).toBe(true);
		expect(s.npxPath).toBe("/usr/bin/npx");
		expect(s.port).toBe(PORT);
	});

	it("port free ⇒ not running, not conflicting", async () => {
		h.findPortHolders.mockResolvedValue([]);
		const s = await getPxpipeProxyStatus();
		expect(s.portInUse).toBe(false);
		expect(s.running).toBe(false);
		expect(s.foreignConflict).toBe(false);
	});

	it("port held by a foreign process ⇒ foreignConflict, not running", async () => {
		h.findPortHolders.mockResolvedValue([{ port: PORT, pid: 99999, processName: "some-server" }]);
		const s = await getPxpipeProxyStatus();
		expect(s.portInUse).toBe(true);
		expect(s.running).toBe(false);
		expect(s.foreignConflict).toBe(true);
		expect(s.holderName).toBe("some-server");
		expect(s.holderPid).toBe(99999);
	});

	it("port held by our managed pid ⇒ running", async () => {
		// Use the live test pid so isAlive() is true and holder.pid === managedPid.
		h.fs.existsSync.mockReturnValue(true);
		h.fs.readFileSync.mockReturnValue(String(process.pid));
		h.findPortHolders.mockResolvedValue([{ port: PORT, pid: process.pid, processName: "node" }]);
		const s = await getPxpipeProxyStatus();
		expect(s.running).toBe(true);
		expect(s.foreignConflict).toBe(false);
	});

	it("port held by a descendant of our managed pid ⇒ running", async () => {
		h.fs.existsSync.mockReturnValue(true);
		h.fs.readFileSync.mockReturnValue(String(process.pid));
		h.getDescendantPids.mockResolvedValue([55555]);
		h.findPortHolders.mockResolvedValue([{ port: PORT, pid: 55555, processName: "node" }]);
		const s = await getPxpipeProxyStatus();
		expect(s.running).toBe(true);
	});
});

describe("startPxpipeProxy", () => {
	it("throws when npx is missing", async () => {
		stubNpx(false);
		await expect(startPxpipeProxy()).rejects.toThrow(/npx/);
	});

	it("throws on a foreign port conflict", async () => {
		h.findPortHolders.mockResolvedValue([{ port: PORT, pid: 99999, processName: "some-server" }]);
		await expect(startPxpipeProxy()).rejects.toThrow(/in use/);
	});

	it("spawns the proxy and writes a pidfile when idle", async () => {
		const s = await startPxpipeProxy();
		expect(h.spawnMock).toHaveBeenCalledWith(["npx", "-y", "pxpipe-proxy"], expect.anything());
		expect(h.fs.writeFileSync).toHaveBeenCalledWith(expect.stringContaining("pxpipe-proxy.pid"), "4242");
		expect(s.port).toBe(PORT);
	});
});

describe("stopPxpipeProxy", () => {
	it("clears the pidfile and waits for the port to free", async () => {
		h.fs.existsSync.mockReturnValue(true);
		h.fs.readFileSync.mockReturnValue("999999"); // non-existent pid → kill is a no-op
		await stopPxpipeProxy();
		expect(h.fs.rmSync).toHaveBeenCalledWith(expect.stringContaining("pxpipe-proxy.pid"), expect.anything());
		expect(h.waitForPortsFree).toHaveBeenCalled();
	});
});
