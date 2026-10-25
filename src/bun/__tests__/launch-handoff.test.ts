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
	it("hands off an ordinary Linux desktop launch", () => {
		expect(shouldTryLaunchHandoff({ platform: "linux", env: {} })).toBe(true);
	});

	it.each(["darwin", "win32"] as const)("leaves %s launches exactly as they were", (platform) => {
		expect(shouldTryLaunchHandoff({ platform, env: {} })).toBe(false);
	});

	it("never hands off a guest instance launched from a task pane", () => {
		expect(shouldTryLaunchHandoff({ platform: "linux", env: { DEV3_TASK_ID: "task-uuid" } })).toBe(false);
	});

	it("never hands off a dev launch", () => {
		expect(shouldTryLaunchHandoff({ platform: "linux", env: { DEV3_FRESH_START: "1" } })).toBe(false);
	});
});

describe("decideLaunchActivation", () => {
	const base = { platform: "linux" as const, bundle: BUNDLE, ownBundle: BUNDLE, hostTaskId: null, windowCount: 0 };

	it("reopens a window when the last one was closed", () => {
		expect(decideLaunchActivation(base)).toEqual({ activated: true, open: true });
	});

	it("raises an existing window instead of adding one when windows are open", () => {
		expect(decideLaunchActivation({ ...base, windowCount: 2 })).toEqual({ activated: true, open: false });
	});

	it("declines a launch of a different install (a dev build or another channel)", () => {
		expect(decideLaunchActivation({ ...base, bundle: "/home/me/dev-3.0/build/views" })).toMatchObject({ activated: false, reason: "other-install" });
	});

	it("declines when this instance is itself a guest of a task", () => {
		expect(decideLaunchActivation({ ...base, hostTaskId: "task-uuid" })).toMatchObject({ activated: false, reason: "guest-instance" });
	});

	it("declines off Linux", () => {
		expect(decideLaunchActivation({ ...base, platform: "darwin" })).toMatchObject({ activated: false, reason: "platform" });
	});
});

describe("handleLaunchActivate", () => {
	afterEach(() => setLaunchActivationHost(null));

	it("declines on an instance with no window host (headless remote)", () => {
		expect(handleLaunchActivate({ bundle: BUNDLE })).toEqual({ activated: false, reason: "no-window-host" });
	});

	it("passes the newcomer's bundle to the installed host", () => {
		const host = vi.fn(() => ({ activated: true }));
		setLaunchActivationHost(host);
		expect(handleLaunchActivate({ bundle: BUNDLE })).toEqual({ activated: true });
		expect(host).toHaveBeenCalledWith(BUNDLE);
	});

	it("declines a request that names no bundle", () => {
		setLaunchActivationHost(() => ({ activated: true }));
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

	it("launches normally when nothing is running", async () => {
		const request = vi.fn<PeerRequest>();
		await expect(handOffToRunningInstance({ peers: () => [], request, bundle: BUNDLE })).resolves.toBeNull();
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

	it("ignores loopback endpoint records", async () => {
		const request = vi.fn<PeerRequest>(() => reply({ activated: true }));
		await expect(handOffToRunningInstance({ peers: () => ["/s/9.endpoint.json"], request, bundle: BUNDLE })).resolves.toBeNull();
		expect(request).not.toHaveBeenCalled();
	});
});

describe("last-window semantics", () => {
	it("still keeps the backend alive after the last window closes", () => {
		// The handoff relies on it: remote access, the tunnel and native-backend
		// terminals must survive a closed window on every platform.
		expect(electrobunConfig.runtime.exitOnLastWindowClosed).toBe(false);
	});
});
