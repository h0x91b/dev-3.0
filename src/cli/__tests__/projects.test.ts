import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resolve } from "node:path";
import { handleProjects } from "../commands/projects";
import { parseArgs } from "../args";
import type { Project, CliResponse, SpacesFile } from "../../shared/types";
import { SPACE_REF_INVALID_PREFIX, type ProjectRegistrationResult } from "../../shared/project-registration";

vi.mock("../socket-client", () => ({
	sendRequest: vi.fn(),
}));

import { sendRequest } from "../socket-client";
const mockSend = vi.mocked(sendRequest);

let stdoutOutput: string;
let stderrOutput: string;
let stdoutSpy: ReturnType<typeof vi.spyOn>;
let stderrSpy: ReturnType<typeof vi.spyOn>;
let exitSpy: ReturnType<typeof vi.spyOn>;

const SOCKET = "/tmp/test.sock";

const PROJECTS: Project[] = [
	{
		id: "proj-aaaa-bbbb-cccc-dddddddddddd",
		name: "My App",
		path: "/Users/dev/my-app",
		setupScript: "",
		devScript: "",
		cleanupScript: "",
		defaultBaseBranch: "main",
		createdAt: "2026-03-01T10:00:00Z",
	},
	{
		id: "proj-1111-2222-3333-444444444444",
		name: "Backend API",
		path: "/Users/dev/backend",
		setupScript: "",
		devScript: "",
		cleanupScript: "",
		defaultBaseBranch: "develop",
		createdAt: "2026-03-01T11:00:00Z",
	},
];

const SPACES: SpacesFile = {
	version: 1,
	spaces: [{ id: "sp_99999999-0000-0000-0000-000000000000", name: "Work / Side", parentId: null, projectIds: [PROJECTS[0].id], createdAt: 1 }],
	order: [],
};

/** Answer `projects.list` and `spaces.list` the way the app does. */
function answerLists(projects: Project[] = PROJECTS, spaces: SpacesFile = SPACES) {
	mockSend.mockImplementation(async (_socket, method) =>
		method === "spaces.list" ? okResp(spaces) : okResp(projects));
}

function okResp(data: unknown): CliResponse {
	return { id: "test-id", ok: true, data };
}

function errResp(error: string): CliResponse {
	return { id: "test-id", ok: false, error };
}

beforeEach(() => {
	stdoutOutput = "";
	stderrOutput = "";
	stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
		stdoutOutput += String(chunk);
		return true;
	});
	stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
		stderrOutput += String(chunk);
		return true;
	});
	exitSpy = vi.spyOn(process, "exit").mockImplementation((_code?: string | number | null) => {
		throw new Error(`EXIT_${_code ?? 0}`);
	}) as ReturnType<typeof vi.spyOn>;
	mockSend.mockReset();
});

afterEach(() => {
	stdoutSpy.mockRestore();
	stderrSpy.mockRestore();
	exitSpy.mockRestore();
});

describe("projects list", () => {
	it("lists projects in a table with their spaces", async () => {
		answerLists();

		await handleProjects("list", { positional: [], flags: {} }, SOCKET);

		expect(mockSend).toHaveBeenCalledWith(SOCKET, "projects.list");
		expect(mockSend).toHaveBeenCalledWith(SOCKET, "spaces.list");
		expect(stdoutOutput).toContain("ID");
		expect(stdoutOutput).toContain("NAME");
		expect(stdoutOutput).toContain("SPACES");
		expect(stdoutOutput).toContain("PATH");
		expect(stdoutOutput).toMatch(/My App\s+Work \/ Side\s+\/Users\/dev\/my-app/);
		expect(stdoutOutput).toMatch(/Backend API\s+-\s+\/Users\/dev\/backend/);
	});

	it("prints full ids and space ids with --json", async () => {
		answerLists();

		await handleProjects("list", { positional: [], flags: { json: "true" } }, SOCKET);

		const listed = JSON.parse(stdoutOutput);
		expect(listed[0]).toEqual({
			id: PROJECTS[0].id,
			name: "My App",
			path: "/Users/dev/my-app",
			kind: "git",
			defaultBaseBranch: "main",
			spaces: [{ id: SPACES.spaces[0].id, name: "Work / Side" }],
		});
		expect(listed[1].spaces).toEqual([]);
	});

	// A CLI updated before the app restarted must not lose the command it already had.
	it("still lists projects when the app is older than spaces.list", async () => {
		mockSend.mockImplementation(async (_socket, method) =>
			method === "spaces.list" ? errResp("Unknown method: spaces.list") : okResp(PROJECTS));

		await handleProjects("list", { positional: [], flags: {} }, SOCKET);

		expect(stdoutOutput).toMatch(/My App\s+-\s+\/Users\/dev\/my-app/);
		expect(stderrOutput).toBe("");
	});

	it("shows short (8-char) project IDs", async () => {
		answerLists();

		await handleProjects("list", { positional: [], flags: {} }, SOCKET);

		expect(stdoutOutput).toContain("proj-aaa");
		expect(stdoutOutput).not.toContain("proj-aaaa-bbbb");
	});

	it("prints message for empty project list", async () => {
		answerLists([]);

		await handleProjects("list", { positional: [], flags: {} }, SOCKET);

		expect(stdoutOutput).toContain("No projects configured");
	});

	it("defaults to 'list' when no subcommand", async () => {
		answerLists();

		await handleProjects(undefined, { positional: [], flags: {} }, SOCKET);

		expect(mockSend).toHaveBeenCalledWith(SOCKET, "projects.list");
	});

	it("exits on server error", async () => {
		mockSend.mockResolvedValue(errResp("Internal error"));

		await expect(
			handleProjects("list", { positional: [], flags: {} }, SOCKET),
		).rejects.toThrow("EXIT_1");
	});

	it("exits with error for unknown subcommand", async () => {
		await expect(
			handleProjects("create", { positional: [], flags: {} }, SOCKET),
		).rejects.toThrow("EXIT_3");
		expect(stderrOutput).toContain("Unknown subcommand");
	});
});

function added(outcome: ProjectRegistrationResult["outcome"] = "added"): ProjectRegistrationResult {
	return {
		outcome,
		project: {
			id: "a1b2c3d4-0000-0000-0000-000000000000",
			name: "side-project",
			path: "/Users/dev/side-project",
			kind: "git",
			defaultBaseBranch: "main",
			spaces: [{ id: "sp_99999999-0000-0000-0000-000000000000", name: "Work / Side" }],
		},
		createdSpaces: [],
	};
}

const run = (argv: string[]) => handleProjects(argv[0], parseArgs(argv.slice(1)), SOCKET);

describe("projects add", () => {
	it("sends the absolute path and every space flag", async () => {
		mockSend.mockResolvedValue(okResp(added()));

		await run(["add", "/Users/dev/side-project", "--space", "Work / Side", "--space", "sp_12345678", "--new-space", "Side", "--name", "Side Project"]);

		expect(mockSend).toHaveBeenCalledWith(SOCKET, "projects.add", {
			path: "/Users/dev/side-project",
			name: "Side Project",
			init: false,
			spaces: ["Work / Side", "sp_12345678"],
			newSpaces: ["Side"],
			noSpace: false,
		}, expect.objectContaining({ timeoutMs: expect.any(Number) }));
		expect(stdoutOutput).toContain('Added project a1b2c3d4 "side-project"');
		expect(stdoutOutput).toContain("Spaces: Work / Side");
	});

	it("resolves a relative path against the current directory", async () => {
		mockSend.mockResolvedValue(okResp(added()));

		await run(["add", "some/repo"]);

		expect(mockSend.mock.calls[0][2]).toMatchObject({ path: resolve("some/repo") });
	});

	// `parseArgs` hands a bare flag the next word; `--init <path>` must not eat the path.
	it("keeps the path when a boolean flag comes right before it", async () => {
		mockSend.mockResolvedValue(okResp(added()));

		await run(["add", "--init", "/Users/dev/side-project", "--no-space"]);

		expect(mockSend.mock.calls[0][2]).toMatchObject({ path: "/Users/dev/side-project", init: true, noSpace: true });
	});

	it("refuses a git URL and points at clone, sending nothing", async () => {
		await expect(run(["add", "https://gitlab.example.com/group/notes-app"])).rejects.toThrow("EXIT_3");

		expect(mockSend).not.toHaveBeenCalled();
		expect(stderrOutput).toContain("dev3 projects clone https://gitlab.example.com/group/notes-app");
	});

	it("refuses --no-space with --space", async () => {
		await expect(run(["add", "/x", "--no-space", "--space", "A"])).rejects.toThrow("EXIT_3");
		expect(mockSend).not.toHaveBeenCalled();
	});

	it("refuses a bare --space with no value", async () => {
		await expect(run(["add", "/x", "--space"])).rejects.toThrow("EXIT_3");
		expect(stderrOutput).toContain("--space needs a value");
	});

	it("exits 33 for an already-registered folder, printing it", async () => {
		mockSend.mockResolvedValue(okResp(added("exists")));

		await expect(run(["add", "/Users/dev/side-project"])).rejects.toThrow("EXIT_33");

		expect(stdoutOutput).toContain('Already a project: a1b2c3d4 "side-project"');
		expect(stdoutOutput).toContain("Nothing changed");
	});

	it("still prints the JSON result before exiting 33", async () => {
		mockSend.mockResolvedValue(okResp(added("exists")));

		await expect(run(["add", "/Users/dev/side-project", "--json"])).rejects.toThrow("EXIT_33");

		expect(JSON.parse(stdoutOutput)).toMatchObject({ outcome: "exists", project: { id: "a1b2c3d4-0000-0000-0000-000000000000" } });
	});

	it("exits 34 when the app refuses a space, without the prefix", async () => {
		mockSend.mockResolvedValue(errResp(`${SPACE_REF_INVALID_PREFIX}No space matches "Nope". Spaces: "A" (sp_11111111).`));

		await expect(run(["add", "/x", "--space", "Nope"])).rejects.toThrow("EXIT_34");

		expect(stderrOutput).toContain('error: No space matches "Nope"');
		expect(stderrOutput).not.toContain(SPACE_REF_INVALID_PREFIX);
		expect(stderrOutput).toContain("dev3 spaces list");
	});

	// The project exists by then, so exit 34 ("nothing written") would be a lie.
	it("does not read a space-ref message inside a later failure as exit 34", async () => {
		mockSend.mockResolvedValue(errResp(`Project a1b2c3d4 was added, but setting its spaces failed: ${SPACE_REF_INVALID_PREFIX}No space matches "X".`));

		await expect(run(["add", "/x", "--space", "X"])).rejects.toThrow("EXIT_1");
	});

	it("says the app is too old when it does not know the method", async () => {
		mockSend.mockResolvedValue(errResp("Unknown method: projects.add"));

		await expect(run(["add", "/x"])).rejects.toThrow("EXIT_1");

		expect(stderrOutput).toContain("older than this CLI");
	});
});

describe("projects clone", () => {
	it("sends the URL as-is and resolves --dir", async () => {
		mockSend.mockResolvedValue(okResp(added()));

		await run(["clone", "git@example.com:group/app.git", "--dir", "clones", "--space", "Work / Side"]);

		expect(mockSend).toHaveBeenCalledWith(SOCKET, "projects.clone", {
			url: "git@example.com:group/app.git",
			dir: resolve("clones"),
			name: undefined,
			spaces: ["Work / Side"],
			newSpaces: [],
			noSpace: false,
		}, expect.objectContaining({ timeoutMs: expect.any(Number) }));
	});

	it("leaves the folder to the app's clone setting without --dir", async () => {
		mockSend.mockResolvedValue(okResp(added()));

		await run(["clone", "https://example.com/group/app.git"]);

		expect(mockSend.mock.calls[0][2]).toMatchObject({ dir: undefined });
	});

	it("needs exactly one URL", async () => {
		await expect(run(["clone"])).rejects.toThrow("EXIT_3");
		expect(mockSend).not.toHaveBeenCalled();
	});
});

describe("projects get|set", () => {
	const PROJECT_ID = PROJECTS[0].id;
	const TASK_CTX = { projectId: PROJECT_ID, taskId: "task-aaaa-bbbb-cccc-dddddddddddd", socketPath: SOCKET };
	const runIn = (argv: string[], context: Parameters<typeof handleProjects>[3] = null) =>
		handleProjects(argv[0], parseArgs(argv.slice(1)), SOCKET, context);
	const VALUES = { name: "My App", gitWorkflow: true, storageRoot: "home", useRepoConfig: true, boardCopy: false, boardCopyMessages: false };

	it("prints every switch with its meaning", async () => {
		mockSend.mockResolvedValue(okResp(VALUES));
		await runIn(["get", "--project", PROJECT_ID]);
		expect(mockSend).toHaveBeenCalledWith(SOCKET, "projects.settings.get", { projectId: PROJECT_ID });
		expect(stdoutOutput).toMatch(/gitWorkflow\s+on\s+Worktrees/);
		expect(stdoutOutput).toMatch(/storageRoot\s+home/);
	});

	it("prints one value raw, or as JSON with --json", async () => {
		mockSend.mockResolvedValue(okResp(VALUES));
		await runIn(["get", "boardCopy"], TASK_CTX);
		expect(stdoutOutput).toBe("off\n");
		stdoutOutput = "";
		await runIn(["get", "boardCopy", "--json"], TASK_CTX);
		expect(stdoutOutput).toBe("false\n");
	});

	it("sends a typed value and prints the change", async () => {
		mockSend.mockResolvedValue(okResp({ key: "gitWorkflow", previous: true, value: false }));
		await runIn(["set", "gitWorkflow", "off", "--project", PROJECT_ID]);
		expect(mockSend).toHaveBeenCalledWith(SOCKET, "projects.settings.set", { projectId: PROJECT_ID, key: "gitWorkflow", value: false }, expect.anything());
		expect(stdoutOutput).toBe("gitWorkflow: on -> off\n");
	});

	it("names the calling task so the app can refuse it, and exits 49 when it does", async () => {
		mockSend.mockResolvedValue(errResp("project-setting-forbidden: Only the user or a coordinator task can change gitWorkflow."));
		await expect(runIn(["set", "gitWorkflow", "off"], TASK_CTX)).rejects.toThrow("EXIT_49");
		expect(mockSend.mock.calls[0]![2]).toMatchObject({ sourceTaskId: TASK_CTX.taskId });
		expect(stderrOutput).toContain("Only the user or a coordinator task can change gitWorkflow.");
		expect(stderrOutput).not.toContain("project-setting-forbidden");
	});

	it("rejects an unknown key, a bad value and a missing value before calling the app", async () => {
		await expect(runIn(["set", "sensitive", "off"], TASK_CTX)).rejects.toThrow("EXIT_3");
		expect(stderrOutput).toContain("Settable: name, gitWorkflow");
		await expect(runIn(["set", "gitWorkflow", "maybe"], TASK_CTX)).rejects.toThrow("EXIT_3");
		await expect(runIn(["set", "storageRoot"], TASK_CTX)).rejects.toThrow("EXIT_3");
		expect(mockSend).not.toHaveBeenCalled();
	});
});
