import { describe, expect, it, vi } from "vitest";
import {
	createWindowsJobWithApi,
	forceTerminateWindowsJobWithApi,
	isProcessInWindowsJobWithApi,
	isValidSessionToken,
	windowsJobExistsWithApi,
	windowsJobName,
	type WindowsJobApi,
} from "../windows-job";

const TOKEN = "0123456789abcdef0123456789abcdef0123456789abcdef";

function makeApi(): WindowsJobApi {
	return {
		createJob: vi.fn(() => 11n),
		setExtendedLimitInformation: vi.fn(() => true),
		openProcess: vi.fn(() => 12n),
		assignProcess: vi.fn(() => true),
		openJob: vi.fn(() => 11n),
		terminateJob: vi.fn(() => true),
		isProcessInJob: vi.fn(() => true),
		closeHandle: vi.fn(() => true),
		setLastError: vi.fn(),
		lastError: vi.fn(() => 0),
		dispose: vi.fn(),
	};
}

describe("native-session Windows Job Object containment", () => {
	it("names jobs in a registry-specific namespace and rejects bad tokens", () => {
		expect(windowsJobName(TOKEN)).toBe(`Local\\dev3-native-sess-${TOKEN}`);
		expect(() => windowsJobName("short")).toThrow("invalid native-session token");
	});

	it("validates the 48-hex session token format", () => {
		expect(isValidSessionToken(TOKEN)).toBe(true);
		for (const bad of ["", "short", "ghost-tok", "z".repeat(48), "a".repeat(47), "a".repeat(49)]) {
			expect(isValidSessionToken(bad)).toBe(false);
		}
	});

	it("enrols the host before spawn with kill-on-close", () => {
		const api = makeApi();
		const containment = createWindowsJobWithApi(TOKEN, 4242, api);

		expect(containment.name).toBe(windowsJobName(TOKEN));
		expect(api.setLastError).toHaveBeenCalledWith(0);
		expect(api.openProcess).toHaveBeenCalledWith(4242);
		expect(api.assignProcess).toHaveBeenCalledWith(11n, 12n);

		const limits = vi.mocked(api.setExtendedLimitInformation).mock.calls[0]?.[1];
		expect(limits).toBeInstanceOf(BigUint64Array);
		expect(new DataView(limits!.buffer).getUint32(16, true)).toBe(0x00002000);
		containment.closeForTreeTermination();
	});

	it("closes the owning job and API exactly once", () => {
		const api = makeApi();
		const containment = createWindowsJobWithApi(TOKEN, 4242, api);
		vi.mocked(api.closeHandle).mockClear();
		vi.mocked(api.dispose).mockClear();

		expect(containment.closeForTreeTermination()).toBe(true);
		expect(containment.closeForTreeTermination()).toBe(false);
		expect(api.closeHandle).toHaveBeenCalledOnce();
		expect(api.closeHandle).toHaveBeenCalledWith(11n);
		expect(api.dispose).toHaveBeenCalledOnce();
	});

	it("refuses to reuse an already-existing job name", () => {
		const api = makeApi();
		vi.mocked(api.lastError).mockReturnValue(183);
		expect(() => createWindowsJobWithApi(TOKEN, 4242, api)).toThrow("refusing to reuse existing Windows Job Object");
		expect(api.dispose).toHaveBeenCalledOnce();
	});

	it("force-terminates only the job named by the selected token", () => {
		const api = makeApi();
		expect(forceTerminateWindowsJobWithApi(TOKEN, api)).toBe(true);
		expect(api.openJob).toHaveBeenCalledWith(windowsJobName(TOKEN), 0x0008);
		expect(api.terminateJob).toHaveBeenCalledWith(11n);
		expect(api.dispose).toHaveBeenCalledOnce();
	});

	it("queries membership and releases temporary handles", () => {
		const api = makeApi();
		expect(isProcessInWindowsJobWithApi(TOKEN, 4343, api)).toBe(true);
		expect(api.openJob).toHaveBeenCalledWith(windowsJobName(TOKEN), 0x0004);
		expect(api.openProcess).toHaveBeenCalledWith(4343, 0x1000);
		expect(api.isProcessInJob).toHaveBeenCalledWith(12n, 11n);
		expect(api.dispose).toHaveBeenCalledOnce();
	});

	it("reports a missing named job without leaking the API library", () => {
		const api = makeApi();
		vi.mocked(api.openJob).mockReturnValue(0n);
		expect(windowsJobExistsWithApi(TOKEN, api)).toBe(false);
		expect(api.closeHandle).not.toHaveBeenCalled();
		expect(api.dispose).toHaveBeenCalledOnce();
	});
});
