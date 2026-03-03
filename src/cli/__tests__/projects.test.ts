import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handleProjects } from "../commands/projects";
import type { Project, CliResponse } from "../../shared/types";

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
		clonePaths: [],
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
		clonePaths: [],
		createdAt: "2026-03-01T11:00:00Z",
	},
];

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
	it("lists projects in a table", async () => {
		mockSend.mockResolvedValue(okResp(PROJECTS));

		await handleProjects("list", { positional: [], flags: {} }, SOCKET);

		expect(mockSend).toHaveBeenCalledWith(SOCKET, "projects.list");
		expect(stdoutOutput).toContain("ID");
		expect(stdoutOutput).toContain("NAME");
		expect(stdoutOutput).toContain("PATH");
		expect(stdoutOutput).toContain("My App");
		expect(stdoutOutput).toContain("Backend API");
	});

	it("shows short (8-char) project IDs", async () => {
		mockSend.mockResolvedValue(okResp(PROJECTS));

		await handleProjects("list", { positional: [], flags: {} }, SOCKET);

		expect(stdoutOutput).toContain("proj-aaa");
		expect(stdoutOutput).not.toContain("proj-aaaa-bbbb");
	});

	it("prints message for empty project list", async () => {
		mockSend.mockResolvedValue(okResp([]));

		await handleProjects("list", { positional: [], flags: {} }, SOCKET);

		expect(stdoutOutput).toContain("No projects configured");
	});

	it("defaults to 'list' when no subcommand", async () => {
		mockSend.mockResolvedValue(okResp(PROJECTS));

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
