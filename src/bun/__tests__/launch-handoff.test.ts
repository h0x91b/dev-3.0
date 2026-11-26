import { describe, it, expect, vi, afterEach } from "vitest";
import {
	LAUNCH_ACTIVATE_METHOD,
	decideLaunchActivation,
	handOffToRunningInstance,
	handleLaunchActivate,
	setLaunchActivationHost,
	shouldTryLaunchHandoff,
	type PeerRequest,
} from "../launch-handoff";
import electrobunConfig from "../../../electrobun.config";

const BUNDLE = "/opt/dev3/Resources/app/views";

describe("shouldTryLaunchHandoff", () => {
	it("hands off only an ordinary Linux desktop launch — never macOS/Windows, a task-pane guest or a dev launch", () => {
		const cases: Array<[name: string, platform: NodeJS.Platform, env: Record<string, string>, expected: boolean]> = [
			["ordinary Linux launch", "linux", {}, true],
			["darwin left as it was", "darwin", {}, false],
			["win32 left as it was", "win32", {}, false],
			["guest instance from a task pane", "linux", { DEV3_TASK_ID: "task-uuid" }, false],
			["dev launch", "linux", { DEV3_FRESH_START: "1" }, false],
		];
		for (const [name, platform, env, expected] of cases) {
			expect(shouldTryLaunchHandoff({ platform, env }), name).toBe(expected);
		}
	});
});

describe("decideLaunchActivation", () => {
	const base = { platform: "linux" as const, bundle: BUNDLE, ownBundle: BUNDLE, hostTaskId: null, windowCount: 0 };

	it("reopens a window when the last one was closed, and raises an existing one instead of adding one", () => {
		expect(decideLaunchActivation(base)).toEqual({ activated: true, open: true });
		expect(decideLaunchActivation({ ...base, windowCount: 2 })).toEqual({ activated: true, open: false });
	});

	it("declines another install (a dev build or another channel), a guest-of-a-task instance, and off Linux", () => {
		const cases: Array<[Partial<Parameters<typeof decideLaunchActivation>[0]>, string]> = [
			[{ bundle: "/home/me/dev-3.0/build/views" }, "other-install"],
			[{ hostTaskId: "task-uuid" }, "guest-instance"],
			[{ platform: "darwin" }, "platform"],
		];
		for (const [over, reason] of cases) {
			expect(decideLaunchActivation({ ...base, ...over }), reason).toMatchObject({ activated: false, reason });
		}
	});
});

describe("handleLaunchActivate", () => {
	afterEach(() => setLaunchActivationHost(null));

	it("declines on an instance with no window host (headless remote)", () => {
		expect(handleLaunchActivate({ bundle: BUNDLE })).toEqual({ activated: false, reason: "no-window-host" });
	});

	it("passes the newcomer's bundle to the installed host, and declines a request that names none", () => {
		const host = vi.fn(() => ({ activated: true }));
		setLaunchActivationHost(host);
		expect(handleLaunchActivate({ bundle: BUNDLE })).toEqual({ activated: true });
		expect(host).toHaveBeenCalledWith(BUNDLE);
		expect(handleLaunchActivate({})).toEqual({ activated: false, reason: "no-bundle" });
	});
});

describe("handOffToRunningInstance", () => {
	const reply = (data: unknown): ReturnType<PeerRequest> => Promise.resolve({ id: "x", ok: true, data });

	it("stops at the first peer that takes over", async () => {
		const request = vi.fn<PeerRequest>()
			.mockImplementationOnce(() => reply({ activated: false, reason: "other-install" }))
			.mockImplementationOnce(() => reply({ activated: true }));
		const peers = () => ["/s/1.sock", "/s/2.sock", "/s/3.sock"];
		await expect(handOffToRunningInstance({ peers, request, bundle: BUNDLE })).resolves.toBe("/s/2.sock");
		expect(request).toHaveBeenCalledTimes(2);
		expect(request.mock.calls[0][1]).toMatchObject({ method: LAUNCH_ACTIVATE_METHOD, params: { bundle: BUNDLE } });
	});

	it("launches normally when nothing is running, ignoring loopback endpoint records", async () => {
		const request = vi.fn<PeerRequest>(() => reply({ activated: true }));
		await expect(handOffToRunningInstance({ peers: () => [], request, bundle: BUNDLE })).resolves.toBeNull();
		await expect(handOffToRunningInstance({ peers: () => ["/s/9.endpoint.json"], request, bundle: BUNDLE })).resolves.toBeNull();
		expect(request).not.toHaveBeenCalled();
	});

	it("launches normally next to an older instance that does not know the method", async () => {
		const request = vi.fn<PeerRequest>(() => Promise.resolve({ id: "x", ok: false, error: `Unknown method: ${LAUNCH_ACTIVATE_METHOD}` }));
		await expect(handOffToRunningInstance({ peers: () => ["/s/1.sock"], request, bundle: BUNDLE })).resolves.toBeNull();
	});

	it("launches normally when a peer hangs, errors or answers garbage", async () => {
		const request = vi.fn<PeerRequest>()
			.mockImplementationOnce(() => Promise.resolve(null))
			.mockImplementationOnce(() => Promise.reject(new Error("ECONNREFUSED")))
			.mockImplementationOnce(() => reply("not an object"));
		const peers = () => ["/s/1.sock", "/s/2.sock", "/s/3.sock"];
		await expect(handOffToRunningInstance({ peers, request, bundle: BUNDLE })).resolves.toBeNull();
		expect(request).toHaveBeenCalledTimes(3);
	});
});

describe("last-window semantics", () => {
	it("still keeps the backend alive after the last window closes", () => {
		// The handoff relies on it: remote access, the tunnel and native-backend
		// terminals must survive a closed window on every platform.
		expect(electrobunConfig.runtime.exitOnLastWindowClosed).toBe(false);
	});
});
