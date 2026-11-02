import { beforeEach, describe, expect, it, vi } from "vitest";
import { runSecretCommand } from "../secret-command";
import { spawn } from "../spawn";
import type { SecretRequest } from "../../shared/secret-request";
vi.mock("../spawn", () => ({ spawn: vi.fn() }));
const request: SecretRequest = { requestId: "r", projectId: "p", taskId: "t", taskTitle: "Upload", env: "TOKEN", command: ["upload", "--file", "a b"], cwd: "/worktree", expiresAt: 0, runStartedAt: null };

beforeEach(() => { vi.mocked(spawn).mockReset(); });
describe("secret command", () => {
	it("keeps values out of arguments and all stdio, without changing the host environment", async () => {
		vi.mocked(spawn).mockReturnValue({ exited: Promise.resolve(0) } as ReturnType<typeof spawn>);
		const original = process.env.TOKEN;
		expect(await runSecretCommand(request, "test-private-value", new AbortController().signal)).toBe(0);
		expect(spawn).toHaveBeenCalledWith(request.command, expect.objectContaining({
			cwd: "/worktree", env: { TOKEN: "test-private-value" }, stdin: "ignore", stdout: "ignore", stderr: "ignore", killSignal: "SIGKILL",
		}));
		expect(process.env.TOKEN).toBe(original);
	});
	it("refuses an already-cancelled execution", async () => {
		const controller = new AbortController();
		controller.abort();
		await expect(runSecretCommand(request, "test-value", controller.signal)).rejects.toThrow("cancelled");
		expect(spawn).not.toHaveBeenCalled();
	});
});
