import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";

vi.mock("../spawn", () => ({
	spawn: vi.fn(),
	spawnSync: vi.fn(),
}));
vi.mock("../logger", () => ({
	createLogger: () => ({
		debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
	}),
}));

import { spawn as mockSpawn } from "../spawn";
import { _resetState } from "../cloudflare-tunnel";
import {
	exposeTaskPort,
	exposeTaskPortsShared,
	unexposeTaskPort,
	unexposeShared,
	getExposedPorts,
	onTaskPortScanUpdate,
	cleanupTaskTunnels,
	cleanupAllTunnels,
	findSharedTunnelByPort,
	setPortTunnelsPushHook,
	HEADLESS_TASK_ID,
	_resetPortTunnels,
} from "../port-tunnels";

function mockNextSpawn(url: string) {
	const encoder = new TextEncoder();
	(mockSpawn as Mock).mockReturnValueOnce({
		kill: vi.fn(),
		exited: new Promise<void>(() => {}),
		stderr: new ReadableStream({
			start(controller) {
				controller.enqueue(encoder.encode(`INF | ${url}\n`));
				controller.close();
			},
		}),
	});
}

describe("port-tunnels — exposeTaskPort", () => {
	beforeEach(() => {
		_resetState();
		_resetPortTunnels();
		vi.clearAllMocks();
	});

	it("starts a quick tunnel and returns ExposedPort shape", async () => {
		mockNextSpawn("https://quick-a.trycloudflare.com");
		const exposed = await exposeTaskPort("task-1", 3000);

		expect(exposed.kind).toBe("quick");
		expect(exposed.ports).toEqual([3000]);
		expect(exposed.url).toBe("https://quick-a.trycloudflare.com");
		expect(exposed.state).toBe("connected");
		expect(exposed.taskId).toBe("task-1");
	});

	it("is idempotent — re-exposing the same port returns the existing tunnel", async () => {
		mockNextSpawn("https://idem.trycloudflare.com");
		const first = await exposeTaskPort("t", 3000);
		const second = await exposeTaskPort("t", 3000);
		expect(first.url).toBe(second.url);
		expect(mockSpawn).toHaveBeenCalledTimes(1);
	});

	it("emits exposedPortsChanged on start and stop", async () => {
		const push = vi.fn();
		setPortTunnelsPushHook(push);
		mockNextSpawn("https://emit.trycloudflare.com");

		await exposeTaskPort("t", 3000);
		expect(push).toHaveBeenCalledWith("exposedPortsChanged", expect.objectContaining({ taskId: "t" }));

		push.mockClear();
		unexposeTaskPort("t", 3000);
		expect(push).toHaveBeenCalledWith("exposedPortsChanged", { taskId: "t", ports: [] });
	});
});

describe("port-tunnels — exposeTaskPortsShared", () => {
	beforeEach(() => {
		_resetState();
		_resetPortTunnels();
		vi.clearAllMocks();
	});

	it("starts a shared tunnel registered with the given port set", async () => {
		mockNextSpawn("https://shared-a.trycloudflare.com");
		const exposed = await exposeTaskPortsShared("t", [3000, 5173], 9000);
		expect(exposed.kind).toBe("shared");
		expect(exposed.ports).toEqual([3000, 5173]);
		// Shared URLs include the /p/<subtoken>/<first-port>/ capability prefix
		// so users can paste them straight into a browser.
		expect(exposed.url).toMatch(/^https:\/\/shared-a\.trycloudflare\.com\/p\/[\w-]+\/3000\/$/);
	});

	it("merges new ports into an existing shared tunnel without restarting cloudflared", async () => {
		mockNextSpawn("https://shared-merge.trycloudflare.com");
		await exposeTaskPortsShared("t", [3000], 9000);
		const merged = await exposeTaskPortsShared("t", [5173], 9000);

		expect(merged.ports).toEqual([3000, 5173]);
		expect(mockSpawn).toHaveBeenCalledTimes(1);
	});

	it("findSharedTunnelByPort locates the tunnel that owns a port", async () => {
		mockNextSpawn("https://find.trycloudflare.com");
		await exposeTaskPortsShared("t", [3000, 5173], 9000);

		expect(findSharedTunnelByPort(3000)?.taskId).toBe("t");
		expect(findSharedTunnelByPort(5173)?.taskId).toBe("t");
		expect(findSharedTunnelByPort(9999)).toBeUndefined();
	});
});

describe("port-tunnels — liveness auto-stop", () => {
	beforeEach(() => {
		_resetState();
		_resetPortTunnels();
		vi.clearAllMocks();
	});

	it("stops a quick tunnel after 2 consecutive port-scan misses", async () => {
		mockNextSpawn("https://live.trycloudflare.com");
		await exposeTaskPort("t", 3000);
		expect(getExposedPorts("t")).toHaveLength(1);

		onTaskPortScanUpdate("t", []); // miss 1
		expect(getExposedPorts("t")).toHaveLength(1);
		onTaskPortScanUpdate("t", []); // miss 2 → stop
		expect(getExposedPorts("t")).toHaveLength(0);
	});

	it("resets miss counter when the port reappears", async () => {
		mockNextSpawn("https://flap.trycloudflare.com");
		await exposeTaskPort("t", 3000);

		onTaskPortScanUpdate("t", []); // miss 1
		onTaskPortScanUpdate("t", [3000]); // recovered
		onTaskPortScanUpdate("t", []); // miss 1 again, NOT 2
		expect(getExposedPorts("t")).toHaveLength(1);
	});

	it("keeps a shared tunnel alive as long as ANY of its ports is up", async () => {
		mockNextSpawn("https://shared-live.trycloudflare.com");
		await exposeTaskPortsShared("t", [3000, 5173], 9000);

		onTaskPortScanUpdate("t", [5173]); // 3000 missing but 5173 alive
		onTaskPortScanUpdate("t", [5173]);
		expect(getExposedPorts("t")).toHaveLength(1);

		onTaskPortScanUpdate("t", []); // miss 1
		onTaskPortScanUpdate("t", []); // miss 2 → stop
		expect(getExposedPorts("t")).toHaveLength(0);
	});

	it("does not auto-stop tunnels owned by the headless synthetic task", async () => {
		mockNextSpawn("https://headless.trycloudflare.com");
		await exposeTaskPort(HEADLESS_TASK_ID, 3000);

		onTaskPortScanUpdate(HEADLESS_TASK_ID, []);
		onTaskPortScanUpdate(HEADLESS_TASK_ID, []);
		expect(getExposedPorts(HEADLESS_TASK_ID)).toHaveLength(1);
	});
});

describe("port-tunnels — cleanup", () => {
	beforeEach(() => {
		_resetState();
		_resetPortTunnels();
		vi.clearAllMocks();
	});

	it("cleanupTaskTunnels stops every tunnel owned by a task", async () => {
		mockNextSpawn("https://a.trycloudflare.com");
		mockNextSpawn("https://b.trycloudflare.com");
		mockNextSpawn("https://s.trycloudflare.com");
		await exposeTaskPort("t", 3000);
		await exposeTaskPort("t", 5173);
		await exposeTaskPortsShared("t", [3000, 5173], 9000);
		expect(getExposedPorts("t")).toHaveLength(3);

		cleanupTaskTunnels("t");
		expect(getExposedPorts("t")).toHaveLength(0);
	});

	it("cleanupAllTunnels stops every task tunnel", async () => {
		mockNextSpawn("https://a.trycloudflare.com");
		mockNextSpawn("https://b.trycloudflare.com");
		await exposeTaskPort("t1", 3000);
		await exposeTaskPort("t2", 5173);

		cleanupAllTunnels();
		expect(getExposedPorts()).toHaveLength(0);
	});

	it("unexposeShared removes only the shared tunnel, not quick ones", async () => {
		mockNextSpawn("https://q.trycloudflare.com");
		mockNextSpawn("https://s.trycloudflare.com");
		await exposeTaskPort("t", 3000);
		await exposeTaskPortsShared("t", [3000], 9000);

		unexposeShared("t");
		const remaining = getExposedPorts("t");
		expect(remaining).toHaveLength(1);
		expect(remaining[0].kind).toBe("quick");
	});
});
