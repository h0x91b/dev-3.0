import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handleImport, projectOwningPath } from "../commands/import";
import type { ProjectDirect } from "../context";
import type { CliResponse } from "../../shared/types";
import type { ImportableSession } from "../../bun/session-import";

vi.mock("../socket-client", () => ({ sendRequest: vi.fn() }));
vi.mock("../context", async (importOriginal) => ({
	...(await importOriginal<typeof import("../context")>()),
	detectFromWorktreePath: vi.fn(() => null),
	listProjectsDirect: vi.fn(() => []),
	readTasksDirect: vi.fn(() => []),
}));
vi.mock("../../bun/session-import", () => ({
	listImportableSessions: vi.fn(() => []),
	describeImportableSession: vi.fn(() => ({ title: "Derived title", description: "# retold\n" })),
}));

import { sendRequest } from "../socket-client";
import { detectFromWorktreePath, listProjectsDirect, readTasksDirect } from "../context";
import { describeImportableSession, listImportableSessions } from "../../bun/session-import";

const mockSend = vi.mocked(sendRequest);
const mockWorktree = vi.mocked(detectFromWorktreePath);
const mockProjects = vi.mocked(listProjectsDirect);
const mockTasks = vi.mocked(readTasksDirect);
const mockList = vi.mocked(listImportableSessions);
const mockDescribe = vi.mocked(describeImportableSession);

const SOCKET = "/tmp/test.sock";

let stdout: string;
let stderr: string;
let spies: Array<ReturnType<typeof vi.spyOn>>;

function project(extra: Partial<ProjectDirect> = {}): ProjectDirect {
	return { id: "proj-0001", name: "dev-3.0", path: "/Users/me/code/dev-3.0", defaultBaseBranch: "main", ...extra };
}

function session(extra: Partial<ImportableSession> = {}): ImportableSession {
	return {
		source: "claude",
		sessionId: "11111111-2222-3333-4444-555555555555",
		path: "/Users/me/.claude/projects/enc/11111111.jsonl",
		cwd: "/Users/me/code/dev-3.0/packages/api",
		title: "Fix the auth race",
		gitBranch: "feat/auth",
		startedAt: null,
		endedAt: null,
		mtimeMs: Date.now() - 3 * 60_000,
		turns: 12,
		...extra,
	};
}

function okResp(data: unknown): CliResponse {
	return { id: "test-id", ok: true, data };
}

function createdTask(): Record<string, unknown> {
	return { id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", seq: 7, title: "Fix the auth race", description: "" };
}

beforeEach(() => {
	stdout = "";
	stderr = "";
	spies = [
		vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => { stdout += String(chunk); return true; }),
		vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => { stderr += String(chunk); return true; }),
		vi.spyOn(process, "exit").mockImplementation((code?: string | number | null) => { throw new Error(`EXIT_${code ?? 0}`); }),
		vi.spyOn(process, "cwd").mockReturnValue("/Users/me/code/dev-3.0/packages/api"),
	] as Array<ReturnType<typeof vi.spyOn>>;

	mockSend.mockReset();
	mockWorktree.mockReset().mockReturnValue(null);
	mockProjects.mockReset().mockReturnValue([project()]);
	mockTasks.mockReset().mockReturnValue([]);
	mockList.mockReset().mockReturnValue([]);
	mockDescribe.mockReset().mockReturnValue({ title: "Derived title", description: "# retold\n" });
});

afterEach(() => {
	for (const spy of spies) spy.mockRestore();
});

describe("projectOwningPath", () => {
	it("matches a cwd below the project root", () => {
		expect(projectOwningPath("/repo/packages/api", [project({ path: "/repo" })])?.path).toBe("/repo");
	});

	it("does not match a sibling directory sharing a name prefix", () => {
		expect(projectOwningPath("/repo-scratch/src", [project({ path: "/repo" })])).toBeNull();
	});

	it("prefers the deepest project when two nest", () => {
		const projects = [project({ id: "outer", path: "/repo" }), project({ id: "inner", path: "/repo/packages/api" })];
		expect(projectOwningPath("/repo/packages/api/src", projects)?.id).toBe("inner");
	});

	it("ignores deleted and virtual projects", () => {
		const projects = [project({ id: "gone", deleted: true }), project({ id: "ops", kind: "virtual" })];
		expect(projectOwningPath("/Users/me/code/dev-3.0", projects)).toBeNull();
	});
});

describe("dev3 import listing", () => {
	it("resolves the project owning the cwd and lists its sessions", async () => {
		mockList.mockReturnValue([session(), session({ sessionId: "99999999-0000-0000-0000-000000000000", title: null, turns: 3 })]);

		await handleImport([], SOCKET);

		expect(mockList).toHaveBeenCalledWith("/Users/me/code/dev-3.0", expect.objectContaining({ excludeSessionIds: [] }));
		expect(stdout).toContain("2 importable session(s) under dev-3.0");
		expect(stdout).toContain("Fix the auth race");
		expect(stdout).toContain("<no title>");
		expect(stdout).toContain("11111111");
		expect(stdout).toContain("dev3 import --session 11111111");
		expect(mockSend).not.toHaveBeenCalled();
	});

	it("hides sessions a task already owns", async () => {
		mockTasks.mockReturnValue([{ id: "t1", sessionState: { panes: [{ sessionId: "claimed-1" }, {}] } }]);

		await handleImport([], SOCKET);

		expect(mockList).toHaveBeenCalledWith("/Users/me/code/dev-3.0", expect.objectContaining({ excludeSessionIds: ["claimed-1"] }));
	});

	it("says so plainly when the project has nothing importable", async () => {
		await handleImport([], SOCKET);
		expect(stdout).toContain("No importable sessions under dev-3.0");
	});
});

describe("dev3 import with no owning project", () => {
	it("names the directory, the reason, and the next step instead of a terse error", async () => {
		mockProjects.mockReturnValue([project({ name: "other", path: "/Users/me/code/other" })]);

		await expect(handleImport([], SOCKET)).rejects.toThrow("EXIT_17");

		expect(stderr).toContain("No dev3 project owns this directory");
		expect(stderr).toContain("/Users/me/code/dev-3.0/packages/api");
		expect(stderr).toContain("Add Project");
		expect(stderr).toContain("run `dev3 import` again");
		expect(stderr).toContain("Projects registered right now:");
		expect(stderr).toContain("/Users/me/code/other");
		expect(mockSend).not.toHaveBeenCalled();
	});

	it("does not fall back to a project the cwd only shares a parent with", async () => {
		vi.mocked(process.cwd).mockReturnValue("/Users/me/code");
		await expect(handleImport([], SOCKET)).rejects.toThrow("EXIT_17");
		expect(stderr).toContain("No dev3 project owns this directory");
	});

	it("reports an empty board rather than an empty list", async () => {
		mockProjects.mockReturnValue([]);
		await expect(handleImport([], SOCKET)).rejects.toThrow("EXIT_17");
		expect(stderr).toContain("No projects are registered on this board yet.");
	});
});

describe("dev3 import --session", () => {
	it("imports the selected session with its branch and origin cwd", async () => {
		const other = session({ sessionId: "99999999-0000-0000-0000-000000000000", gitBranch: "other" });
		mockList.mockReturnValue([other, session()]);
		mockSend.mockResolvedValue(okResp(createdTask()));

		await handleImport(["--session", "11111111", "--yes"], SOCKET);

		expect(mockSend).toHaveBeenCalledTimes(1);
		const [socket, method, params] = mockSend.mock.calls[0];
		expect(socket).toBe(SOCKET);
		expect(method).toBe("task.create");
		expect(params).toMatchObject({
			projectId: "proj-0001",
			title: "Derived title",
			description: "# retold\n",
			existingBranch: "feat/auth",
			importSession: {
				sessionId: "11111111-2222-3333-4444-555555555555",
				originCwd: "/Users/me/code/dev-3.0/packages/api",
			},
		});
		expect(stdout).toContain("as task aaaaaaaa (seq 7)");
	});

	it("accepts -y as the short form of --yes", async () => {
		mockList.mockReturnValue([session()]);
		mockSend.mockResolvedValue(okResp(createdTask()));

		await handleImport(["--session", "11111111", "-y"], SOCKET);

		expect(mockSend).toHaveBeenCalledTimes(1);
	});

	it("falls back to the project's base branch when the session was on a detached HEAD", async () => {
		mockList.mockReturnValue([session({ gitBranch: "HEAD" })]);
		mockSend.mockResolvedValue(okResp(createdTask()));

		await handleImport(["--session", "11111111", "--yes"], SOCKET);

		const params = mockSend.mock.calls[0][2] as Record<string, unknown>;
		expect(params).not.toHaveProperty("existingBranch");
		expect(params).toHaveProperty("importSession");
	});

	it("sends no branch when the transcript recorded none", async () => {
		mockList.mockReturnValue([session({ gitBranch: null })]);
		mockSend.mockResolvedValue(okResp(createdTask()));

		await handleImport(["--session", "11111111", "--yes"], SOCKET);

		expect(mockSend.mock.calls[0][2]).not.toHaveProperty("existingBranch");
	});

	it("names the session when the derived title is empty", async () => {
		mockList.mockReturnValue([session()]);
		mockDescribe.mockReturnValue({ title: null, description: "# retold\n" });
		mockSend.mockResolvedValue(okResp(createdTask()));

		await handleImport(["--session", "11111111", "--yes"], SOCKET);

		expect(mockSend.mock.calls[0][2]).toMatchObject({ title: "Imported claude session 11111111" });
	});

	it("refuses an id that matches nothing here", async () => {
		mockList.mockReturnValue([session()]);
		await expect(handleImport(["--session", "deadbeef", "--yes"], SOCKET)).rejects.toThrow("EXIT_1");
		expect(stderr).toContain("No importable session under this project matches");
		expect(mockSend).not.toHaveBeenCalled();
	});

	it("refuses an ambiguous id prefix", async () => {
		mockList.mockReturnValue([session({ sessionId: "abc-1" }), session({ sessionId: "abc-2" })]);
		await expect(handleImport(["--session", "abc", "--yes"], SOCKET)).rejects.toThrow("EXIT_1");
		expect(stderr).toContain("matches 2 sessions");
	});

	it("reports a socket failure instead of claiming success", async () => {
		mockList.mockReturnValue([session()]);
		mockSend.mockResolvedValue({ id: "x", ok: false, error: "worktree add failed" });
		await expect(handleImport(["--session", "11111111", "--yes"], SOCKET)).rejects.toThrow("EXIT_1");
		expect(stderr).toContain("worktree add failed");
	});

	it("requires --yes when there is no terminal to confirm on", async () => {
		mockList.mockReturnValue([session()]);
		const isTTY = process.stdin.isTTY;
		Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
		try {
			await expect(handleImport(["--session", "11111111"], SOCKET)).rejects.toThrow("EXIT_3");
			expect(stdout).toContain("Import into dev-3.0:");
			expect(stdout).toContain("feat/auth");
			expect(mockSend).not.toHaveBeenCalled();
		} finally {
			Object.defineProperty(process.stdin, "isTTY", { value: isTTY, configurable: true });
		}
	});
});

describe("dev3 import guard rails", () => {
	it("rejects a --project override", async () => {
		await expect(handleImport(["--project", "proj-0001"], SOCKET)).rejects.toThrow("EXIT_3");
		expect(stderr).toContain("--project");
	});

	it("refuses to run inside a dev3 worktree", async () => {
		mockWorktree.mockReturnValue({ projectSlug: "s", taskShortId: "t", realDev3Home: "/home/.dev3.0" });
		await expect(handleImport([], SOCKET)).rejects.toThrow("EXIT_1");
		expect(stderr).toContain("this is a dev3 worktree");
	});
});
