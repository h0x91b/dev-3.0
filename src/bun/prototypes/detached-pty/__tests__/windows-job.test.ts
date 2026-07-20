import { describe, expect, it, vi } from "vitest";
import {
	createWindowsJobWithApi,
	forceTerminateWindowsJobWithApi,
	isProcessInWindowsJobWithApi,
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

describe("detached-pty Windows Job Object containment", () => {
	it("enrols the host before spawn with kill-on-close and closes each handle once", () => {
		const api = makeApi();
		const containment = createWindowsJobWithApi(TOKEN, 4242, api);

		expect(containment.name).toBe(windowsJobName(TOKEN));
		expect(api.setLastError).toHaveBeenCalledWith(0);
		expect(api.createJob).toHaveBeenCalledOnce();
		expect(api.openProcess).toHaveBeenCalledWith(4242);
		expect(api.assignProcess).toHaveBeenCalledWith(11n, 12n);
		expect(api.closeHandle).toHaveBeenCalledWith(12n);

		const limits = vi.mocked(api.setExtendedLimitInformation).mock.calls[0]?.[1];
		expect(limits).toBeInstanceOf(BigUint64Array);
		expect(new DataView(limits!.buffer).getUint32(16, true)).toBe(0x00002000);

		expect(containment.closeForTreeTermination()).toBe(true);
		expect(containment.closeForTreeTermination()).toBe(false);
		expect(api.closeHandle).toHaveBeenCalledTimes(2);
		expect(api.closeHandle).toHaveBeenLastCalledWith(11n);
		expect(api.dispose).toHaveBeenCalledOnce();
	});

	it("releases the job when host enrolment fails", () => {
		const api = makeApi();
		vi.mocked(api.assignProcess).mockReturnValue(false);
		vi.mocked(api.lastError).mockReturnValue(5);

		expect(() => createWindowsJobWithApi(TOKEN, 4242, api)).toThrow("AssignProcessToJobObject failed (Win32 error 5)");
		expect(api.closeHandle).toHaveBeenNthCalledWith(1, 12n);
		expect(api.closeHandle).toHaveBeenNthCalledWith(2, 11n);
		expect(api.dispose).toHaveBeenCalledOnce();
	});

	it("force-terminates only the Job Object named by the selected token", () => {
		const api = makeApi();

		expect(forceTerminateWindowsJobWithApi(TOKEN, api)).toBe(true);
		expect(api.openJob).toHaveBeenCalledWith(windowsJobName(TOKEN), 0x0008);
		expect(api.terminateJob).toHaveBeenCalledWith(11n);
		expect(api.closeHandle).toHaveBeenCalledWith(11n);
		expect(api.dispose).toHaveBeenCalledOnce();
	});

	it("queries membership and releases temporary process and job handles", () => {
		const api = makeApi();

		expect(isProcessInWindowsJobWithApi(TOKEN, 4343, api)).toBe(true);
		expect(api.openJob).toHaveBeenCalledWith(windowsJobName(TOKEN), 0x0004);
		expect(api.openProcess).toHaveBeenCalledWith(4343, 0x1000);
		expect(api.isProcessInJob).toHaveBeenCalledWith(12n, 11n);
		expect(api.closeHandle).toHaveBeenCalledWith(12n);
		expect(api.closeHandle).toHaveBeenCalledWith(11n);
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
