import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WAIT_HEARTBEAT_MS, withWaitHeartbeat } from "../launch-approval";

describe("withWaitHeartbeat", () => {
	let stderr: ReturnType<typeof vi.spyOn>;
	beforeEach(() => {
		vi.useFakeTimers();
		stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
	});
	afterEach(() => {
		stderr.mockRestore();
		vi.useRealTimers();
	});

	it("prints a line every minute, well inside Gemini CLI's 300 s silence limit", async () => {
		let settle!: (value: string) => void;
		const wait = withWaitHeartbeat(new Promise<string>((r) => { settle = r; }));
		expect(WAIT_HEARTBEAT_MS).toBeLessThan(300_000);
		await vi.advanceTimersByTimeAsync(WAIT_HEARTBEAT_MS * 3);
		expect(stderr).toHaveBeenCalledTimes(3);
		expect(String(stderr.mock.calls[2]![0])).toContain("Still waiting for the user's answer in the dev-3.0 app (3 min)");
		settle("approved");
		await expect(wait).resolves.toBe("approved");
	});

	it("stops once the wait ends, whether it settles or throws", async () => {
		await expect(withWaitHeartbeat(Promise.reject(new Error("gone")))).rejects.toThrow("gone");
		await expect(withWaitHeartbeat(Promise.resolve(1))).resolves.toBe(1);
		await vi.advanceTimersByTimeAsync(WAIT_HEARTBEAT_MS * 5);
		expect(stderr).not.toHaveBeenCalled();
	});
});
