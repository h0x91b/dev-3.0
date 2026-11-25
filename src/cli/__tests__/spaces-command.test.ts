import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handleSpaces } from "../commands/spaces";
import { parseArgs } from "../args";
import type { CliContext } from "../context";
import type { CliResponse, Project, SpacesFile } from "../../shared/types";
import { SPACE_REF_INVALID_PREFIX, type CliSpace, type ProjectSpacesChangeResult } from "../../shared/project-registration";

vi.mock("../socket-client", () => ({
	sendRequest: vi.fn(),
}));

import { sendRequest } from "../socket-client";
const mockSend = vi.mocked(sendRequest);

const SOCKET = "/tmp/test.sock";
const PROJECT_ID = "a1b2c3d4-1111-2222-3333-444444444444";
const CTX: CliContext = { projectId: PROJECT_ID, taskId: "aaaaaaaa-1111-2222-3333-444444444444", socketPath: SOCKET };

const PROJECTS: Project[] = [{
	id: PROJECT_ID,
	name: "side-project",
	path: "/Users/dev/side-project",
	setupScript: "",
	devScript: "",
	cleanupScript: "",
	defaultBaseBranch: "main",
	createdAt: "2026-10-18T00:00:00Z",
}];

const SPACES: SpacesFile = {
	version: 1,
	spaces: [
		{ id: "sp_11111111-0000-0000-0000-000000000000", name: "Work / Side", parentId: null, projectIds: [PROJECT_ID], createdAt: 1 },
		{ id: "sp_22222222-0000-0000-0000-000000000000", name: "Empty-ish", parentId: null, projectIds: ["unknown-project"], createdAt: 2 },
	],
	order: [],
};

let stdout: string;
let stderr: string;

function okResp(data: unknown): CliResponse {
	return { id: "test-id", ok: true, data };
}

function changed(spaces: Array<{ id: string; name: string }>, deletedSpaces: Array<{ id: string; name: string }> = []): ProjectSpacesChangeResult {
	return {
		project: { id: PROJECT_ID, name: "side-project", path: "/Users/dev/side-project", kind: "git", defaultBaseBranch: "main", spaces },
		deletedSpaces,
	};
}

const run = (argv: string[], context: CliContext | null = CTX) =>
	handleSpaces(argv[0], parseArgs(argv.slice(1)), SOCKET, context);

beforeEach(() => {
	stdout = "";
	stderr = "";
	vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
		stdout += String(chunk);
		return true;
	});
	vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
		stderr += String(chunk);
		return true;
	});
	vi.spyOn(process, "exit").mockImplementation((code?: string | number | null) => {
		throw new Error(`EXIT_${code ?? 0}`);
	}) as ReturnType<typeof vi.spyOn>;
	mockSend.mockReset();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("spaces list", () => {
	beforeEach(() => {
		mockSend.mockImplementation(async (_socket, method) => okResp(method === "spaces.list" ? SPACES : PROJECTS));
	});

	it("prints each space with its members' short ids, ready for --project", async () => {
		await run(["list"]);

		expect(stdout).toMatch(/sp_11111111\s+Work \/ Side\s+side-project \(a1b2c3d4\)/);
		expect(stdout).toMatch(/sp_22222222\s+Empty-ish\s+-/);
	});

	it("prints full ids with --json, as the default subcommand", async () => {
		await handleSpaces(undefined, parseArgs(["--json"]), SOCKET, CTX);

		const spaces = JSON.parse(stdout) as CliSpace[];
		expect(spaces[0]).toEqual({
			id: SPACES.spaces[0].id,
			name: "Work / Side",
			sensitive: false,
			projects: [{ id: PROJECT_ID, name: "side-project", path: "/Users/dev/side-project" }],
		});
	});

	it("says how to make one when there are none", async () => {
		mockSend.mockImplementation(async (_socket, method) =>
			okResp(method === "spaces.list" ? { version: 1, spaces: [], order: [] } : PROJECTS));

		await run(["list"]);

		expect(stdout).toContain("No spaces");
		expect(stdout).toContain("dev3 spaces create");
	});
});

describe("spaces create", () => {
	it("defaults the member to the current project", async () => {
		mockSend.mockResolvedValue(okResp({ id: "sp_33333333-0000", name: "Side", sensitive: false, projects: [{ id: PROJECT_ID, name: "side-project", path: "/x" }] }));

		await run(["create", "Side"]);

		expect(mockSend).toHaveBeenCalledWith(SOCKET, "spaces.create", { name: "Side", projectIds: [PROJECT_ID] });
		expect(stdout).toContain('Created space sp_33333333 "Side" with side-project (a1b2c3d4)');
	});

	it("takes several --project flags", async () => {
		mockSend.mockResolvedValue(okResp({ id: "sp_3", name: "Side", sensitive: false, projects: [] }));

		await run(["create", "Side", "--project", "aaaaaaaa-0000-0000-0000-000000000000", "--project", "bbbbbbbb-0000-0000-0000-000000000000"], null);

		expect(mockSend.mock.calls[0][2]).toEqual({
			name: "Side",
			projectIds: ["aaaaaaaa-0000-0000-0000-000000000000", "bbbbbbbb-0000-0000-0000-000000000000"],
		});
	});

	it("exits 34 for a name already taken, or a space the app cannot resolve", async () => {
		mockSend.mockResolvedValue({ id: "x", ok: false, error: `${SPACE_REF_INVALID_PREFIX}A space named "Side" already exists (sp_33333333).` });

		await expect(run(["create", "app"])).rejects.toThrow("EXIT_34");
		expect(stderr).toContain("already exists");

		mockSend.mockResolvedValue({ id: "x", ok: false, error: `${SPACE_REF_INVALID_PREFIX}No space matches "Nope".` });
		await expect(run(["remove", "Nope"])).rejects.toThrow("EXIT_34");
		expect(stderr).toContain("dev3 spaces list");
	});
});

describe("spaces set / add / remove", () => {
	it("set sends the refs for the current project and prints the new membership", async () => {
		mockSend.mockResolvedValue(okResp(changed([{ id: "sp_1", name: "Work / Side" }], [{ id: "sp_2", name: "Old" }])));

		await run(["set", "Work / Side"]);

		expect(mockSend).toHaveBeenCalledWith(SOCKET, "spaces.change", { projectId: PROJECT_ID, mode: "set", spaces: ["Work / Side"] });
		expect(stdout).toContain('Project a1b2c3d4 "side-project" is now in: Work / Side');
		expect(stdout).toContain('Space "Old" had no projects left and was deleted.');
	});

	it("set --no-space clears every membership", async () => {
		mockSend.mockResolvedValue(okResp(changed([])));

		await run(["set", "--no-space", "--project", PROJECT_ID], null);

		expect(mockSend.mock.calls[0][2]).toEqual({ projectId: PROJECT_ID, mode: "set", spaces: [] });
		expect(stdout).toContain("is now in no space");
	});

	it("is a usage error, before sending, for a nameless create, an empty set, add/remove without a space, no project, or an unknown subcommand", async () => {
		await expect(run(["create"])).rejects.toThrow("EXIT_3");
		// set without spaces or --no-space warns that it replaces.
		await expect(run(["set"])).rejects.toThrow("EXIT_3");
		expect(stderr).toContain("REPLACES");
		await expect(run(["add"])).rejects.toThrow("EXIT_3");
		await expect(run(["remove", "--no-space"])).rejects.toThrow("EXIT_3");
		await expect(run(["add", "X"], null)).rejects.toThrow("EXIT_3");
		expect(stderr).toContain("--project <id> is required");
		await expect(run(["rename", "x"])).rejects.toThrow("EXIT_3");
		expect(stderr, "lists what exists").toContain("spaces set");
		expect(mockSend).not.toHaveBeenCalled();
	});

	it("add passes several spaces", async () => {
		mockSend.mockResolvedValue(okResp(changed([{ id: "sp_1", name: "A" }, { id: "sp_2", name: "B" }])));

		await run(["add", "A", "sp_22222222", "--json"]);

		expect(mockSend.mock.calls[0][2]).toEqual({ projectId: PROJECT_ID, mode: "add", spaces: ["A", "sp_22222222"] });
		expect(JSON.parse(stdout).project.spaces).toHaveLength(2);
	});
});
