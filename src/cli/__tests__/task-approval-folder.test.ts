import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CliResponse } from "../../shared/types";

vi.mock("../socket-client", () => ({ sendRequest: vi.fn() }));
vi.mock("../context", async (importOriginal) => ({
	...(await importOriginal<typeof import("../context")>()),
	readProjectDirect: vi.fn(),
}));

import { handleTask } from "../commands/task";
import { readProjectDirect, type CliContext } from "../context";
import { sendRequest } from "../socket-client";

const mockSend = vi.mocked(sendRequest);
const mockProject = vi.mocked(readProjectDirect);
const SOCKET = "/tmp/test.sock";
const TASK_ID = "aaaaaaaa-1111-2222-3333-444444444444";
const CTX: CliContext = { projectId: "proj-001", taskId: TASK_ID, socketPath: SOCKET };

let stdout = "";
let stderr = "";

function ok(data: unknown): CliResponse {
	return { id: "t", ok: true, data };
}

beforeEach(() => {
	stdout = "";
	stderr = "";
	vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => (stdout += String(chunk), true));
	vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => (stderr += String(chunk), true));
	vi.spyOn(process, "exit").mockImplementation((code?: string | number | null) => {
		throw new Error(`EXIT_${code ?? 0}`);
	});
	mockSend.mockImplementation(async (_socket, method) =>
		method === "approval.policy" ? ok({}) : ok({ approved: true, task: { id: TASK_ID, status: "completed" } }),
	);
});

afterEach(() => {
	vi.restoreAllMocks();
	mockSend.mockReset();
});

const move = (status: string) => handleTask("move", { positional: [TASK_ID], flags: { status } }, SOCKET, CTX);

describe("approval wording for a task in its project folder", () => {
	it.each(["completed", "cancelled"])("never says %s destroys a worktree when the git workflow is off", async (status) => {
		mockProject.mockReturnValue({ id: "proj-001", name: "Notes", path: "/home/me/notes", gitWorkflow: false });

		await move(status);

		expect(stderr).toContain("keeps every file");
		expect(stderr + stdout).not.toMatch(/worktree/i);
		expect(stdout).toContain("The project folder keeps every file");
	});

	it("keeps the worktree wording for a git project", async () => {
		mockProject.mockReturnValue({ id: "proj-001", name: "App", path: "/home/me/app" });

		await move("completed");

		expect(stderr).toContain("destroys its worktree");
		expect(stdout).toContain("This worktree and terminal session are being destroyed now");
	});
});
