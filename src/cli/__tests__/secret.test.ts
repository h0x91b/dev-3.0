import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleSecret } from "../commands/secret";
import { parseArgs } from "../args";
import { sendRequest } from "../socket-client";
import { CLI_EXIT_CODE_COMMAND_FAILED, CLI_EXIT_CODE_USAGE_ERROR } from "../../shared/cli-exit-codes";
vi.mock("../socket-client", () => ({ sendRequest: vi.fn() }));
const context = { projectId: "p", taskId: "task-0001", socketPath: "/socket" };
let stdout: string;
let stderr: string;
beforeEach(() => {
	stdout = ""; stderr = "";
	vi.mocked(sendRequest).mockReset().mockResolvedValue({ id: "r", ok: true, data: { status: "finished", exitCode: 0 } });
	vi.spyOn(process.stdout, "write").mockImplementation((chunk) => { stdout += String(chunk); return true; });
	vi.spyOn(process.stderr, "write").mockImplementation((chunk) => { stderr += String(chunk); return true; });
	vi.spyOn(process, "exit").mockImplementation((code) => { throw new Error(`EXIT_${code}`); });
});
afterEach(() => vi.restoreAllMocks());

describe("dev3 secret run", () => {
	it("sends only the name and literal argv, and returns only a status message", async () => {
		await handleSecret("run", parseArgs(["--env", "TOKEN", "--", "upload", "--file", "a b"]), "/socket", context);
		expect(sendRequest).toHaveBeenCalledWith("/socket", "secret.run", {
			projectId: "p", taskId: "task-0001", env: "TOKEN", command: ["upload", "--file", "a b"],
		}, { timeoutMs: 930_000 });
		expect(stdout).toBe("Secret command succeeded. Output was discarded.\n");
	});
	it.each([
		["--env", "TOKEN=private-value", "--", "upload"], ["--env", "TOKEN"],
		["--env", "TOKEN", "--value", "private-value", "--", "upload"],
	])("rejects invalid use without echoing a supplied value", async (...args) => {
		await expect(handleSecret("run", parseArgs(args), "/socket", context)).rejects.toThrow(`EXIT_${CLI_EXIT_CODE_USAGE_ERROR}`);
		expect(stderr).not.toContain("private-value");
		expect(sendRequest).not.toHaveBeenCalled();
	});
	it("requires task context", async () => {
		await expect(handleSecret("run", parseArgs(["--env", "TOKEN", "--", "upload"]), "/socket", null)).rejects.toThrow(`EXIT_${CLI_EXIT_CODE_USAGE_ERROR}`);
	});
	it.each(["declined", "expired", "cancelled", "failed"])("reports %s as a failed command", async (status) => {
		vi.mocked(sendRequest).mockResolvedValue({ id: "r", ok: true, data: { status } });
		await expect(handleSecret("run", parseArgs(["--env", "TOKEN", "--", "upload"]), "/socket", context)).rejects.toThrow(`EXIT_${CLI_EXIT_CODE_COMMAND_FAILED}`);
	});
	it("fails on a nonzero child exit code without forwarding output", async () => {
		vi.mocked(sendRequest).mockResolvedValue({ id: "r", ok: true, data: { status: "finished", exitCode: 9, stdout: "private-value" } });
		await expect(handleSecret("run", parseArgs(["--env", "TOKEN", "--", "upload"]), "/socket", context)).rejects.toThrow(`EXIT_${CLI_EXIT_CODE_COMMAND_FAILED}`);
		expect(stdout + stderr).not.toContain("private-value");
	});
});
