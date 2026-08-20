import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handleArtifactTemplate } from "../commands/artifact-template";
import type { CliContext } from "../context";
import type { ParsedArgs } from "../args";
import type { CliResponse } from "../../shared/types";
import { ARTIFACT_TEMPLATE_FILES } from "../../shared/artifact-template";

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
let cwdSpy: ReturnType<typeof vi.spyOn>;
const tempRoots: string[] = [];

const SOCKET = "/tmp/test.sock";
const TASK_ID = "aaaaaaaa-1111-2222-3333-444444444444";
const CTX: CliContext = { projectId: "proj-001", taskId: TASK_ID, socketPath: SOCKET, worktreePath: "/wt-container/worktree" };

function args(flags: Record<string, string> = {}): ParsedArgs {
	return { positional: [], flags };
}

function okResp(dir: string): CliResponse {
	return { id: "test-id", ok: true, data: { dir, taskId: TASK_ID, projectId: "proj-001" } };
}

function tempRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "dev3-artifact-cli-"));
	tempRoots.push(root);
	return root;
}

/** A pristine starter as the app would have provisioned it. */
function starterDir(): string {
	const dir = join(tempRoot(), "artifact-template-v1");
	mkdirSync(dir, { recursive: true });
	for (const name of ARTIFACT_TEMPLATE_FILES) writeFileSync(join(dir, name), `pristine ${name}`);
	return dir;
}

/** Run the command as if the agent's cwd were a fresh worktree. */
function inWorktree(): string {
	const cwd = tempRoot();
	cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(cwd);
	return cwd;
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
	exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: string | number | null) => {
		throw new Error(`EXIT_${code ?? 0}`);
	}) as ReturnType<typeof vi.spyOn>;
	mockSend.mockReset();
});

afterEach(() => {
	stdoutSpy.mockRestore();
	stderrSpy.mockRestore();
	exitSpy.mockRestore();
	cwdSpy?.mockRestore();
	for (const dir of tempRoots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("dev3 artifact-template", () => {
	it("copies the starter into ./dev3-artifact-report and prints where it went", async () => {
		mockSend.mockResolvedValue(okResp(starterDir()));
		const cwd = inWorktree();

		await handleArtifactTemplate(args(), SOCKET, CTX);

		expect(mockSend).toHaveBeenCalledWith(
			SOCKET,
			"artifact.template-dir",
			expect.objectContaining({ taskId: TASK_ID, worktreePath: "/wt-container/worktree" }),
		);
		const target = join(cwd, "dev3-artifact-report");
		expect(readdirSync(target).sort()).toEqual([...ARTIFACT_TEMPLATE_FILES].sort());
		expect(stdoutOutput).toBe(`${target}\n`);
	});

	it("restores the managed files over an existing copy", async () => {
		mockSend.mockResolvedValue(okResp(starterDir()));
		const cwd = inWorktree();
		const target = join(cwd, "dev3-artifact-report");
		mkdirSync(target, { recursive: true });
		writeFileSync(join(target, "app.css"), "mangled");
		writeFileSync(join(target, "report.js"), "the agent's own work");

		await handleArtifactTemplate(args(), SOCKET, CTX);

		expect(readFileSync(join(target, "app.css"), "utf8")).toBe("pristine app.css");
		expect(readFileSync(join(target, "report.js"), "utf8")).toBe("pristine report.js");
	});

	it("targets another task with --task", async () => {
		mockSend.mockResolvedValue(okResp(starterDir()));
		inWorktree();

		await handleArtifactTemplate(args({ task: "seq:7" }), SOCKET, CTX);

		expect(mockSend).toHaveBeenCalledWith(SOCKET, "artifact.template-dir", expect.objectContaining({ taskId: "seq:7" }));
	});

	it("reports the app's failure instead of leaving a half-written copy", async () => {
		mockSend.mockResolvedValue({ id: "test-id", ok: false, error: "Bundled dev3 artifact template not found" });
		const cwd = inWorktree();

		await expect(handleArtifactTemplate(args(), SOCKET, CTX)).rejects.toThrow("EXIT_1");
		expect(stderrOutput).toContain("artifact template not found");
		expect(readdirSync(cwd)).toEqual([]);
	});

	it("asks for --task when there is no task in context", async () => {
		await expect(handleArtifactTemplate(args(), SOCKET, null)).rejects.toThrow("EXIT_3");
		expect(stderrOutput).toContain("--task");
		expect(mockSend).not.toHaveBeenCalled();
	});
});
