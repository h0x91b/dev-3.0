import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { recordDiagnosticMock } = vi.hoisted(() => ({ recordDiagnosticMock: vi.fn() }));
vi.mock("../diagnostics", () => ({ recordDiagnostic: recordDiagnosticMock }));

import { StartupReadCancelled, startupRead } from "../startup-read";

describe("startupRead", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		recordDiagnosticMock.mockReset();
		vi.spyOn(console, "warn").mockImplementation(() => {});
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	// A lost request never settles. Before, App waited on it for the whole session
	// and ran on its placeholder settings.
	it("retries a request that never answers and adopts the retry's answer", async () => {
		const read = vi.fn()
			.mockReturnValueOnce(new Promise(() => {}))
			.mockResolvedValueOnce({ defaultConfigId: "claude-auto-opus55-medium" });
		const result = startupRead("global settings", read, { attemptTimeoutMs: 1_000, retryDelaysMs: [500] });
		await vi.advanceTimersByTimeAsync(1_000);
		expect(recordDiagnosticMock).toHaveBeenCalledWith(expect.objectContaining({ level: "warn", source: "global settings" }));
		await vi.advanceTimersByTimeAsync(500);
		await expect(result).resolves.toEqual({ defaultConfigId: "claude-auto-opus55-medium" });
		expect(read).toHaveBeenCalledTimes(2);
	});

	it("records an error and rejects after the last retry fails", async () => {
		const read = vi.fn().mockRejectedValue(new Error("RPC connection closed"));
		const result = startupRead("agent presets", read, { retryDelaysMs: [100] });
		const settled = result.catch((err: unknown) => err as Error);
		await vi.advanceTimersByTimeAsync(100);
		expect(((await settled) as Error).message).toBe("RPC connection closed");
		expect(read).toHaveBeenCalledTimes(2);
		expect(recordDiagnosticMock).toHaveBeenLastCalledWith(expect.objectContaining({ level: "error", source: "agent presets" }));
	});

	it("stops retrying once cancelled", async () => {
		let cancelled = false;
		const read = vi.fn().mockRejectedValue(new Error("boom"));
		const result = startupRead("tip state", read, { retryDelaysMs: [100, 100], isCancelled: () => cancelled });
		const settled = result.catch((err: unknown) => err as Error);
		cancelled = true;
		await vi.advanceTimersByTimeAsync(100);
		expect(await settled).toBeInstanceOf(StartupReadCancelled);
		expect(read).toHaveBeenCalledTimes(1);
	});
});
