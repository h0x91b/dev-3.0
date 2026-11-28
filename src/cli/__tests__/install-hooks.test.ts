import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../shared/agent-hooks", async (importActual) => ({
	...(await importActual<typeof import("../../shared/agent-hooks")>()),
	writeClaudeHooks: vi.fn(),
	writeCodexHooks: vi.fn(),
}));
vi.mock("../../shared/omp-status-extension", () => ({ writeOmpStatusExtension: vi.fn(() => "/omp") }));
vi.mock("../../shared/pi-status-extension", () => ({ writePiStatusExtension: vi.fn(() => "/pi") }));
vi.mock("../../bun/cursor-hooks", async (importActual) => ({
	...(await importActual<typeof import("../../bun/cursor-hooks")>()),
	writeCursorHooks: vi.fn(async () => ({ status: "installed", path: "/cursor" })),
}));
vi.mock("../../bun/claude-config-git", () => ({
	excludeTaskClaudeSettings: vi.fn(),
	excludeTaskCodexHooks: vi.fn(),
}));

import { writeClaudeHooks, writeCodexHooks } from "../../shared/agent-hooks";
import { resolveDev3Home } from "../../shared/dev3-home";
import { excludeTaskClaudeSettings, excludeTaskCodexHooks } from "../../bun/claude-config-git";
import { handleInstallHooks, handleRemoveCursorHooks } from "../commands/install-hooks";
import { resolveHelp } from "../help";

describe("remove Cursor hooks command", () => {
	let root: string;
	beforeEach(() => { root = mkdtempSync(join(tmpdir(), "dev3-remove-cursor-")); });
	afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

	it("removes managed user hooks without a running app or worktree context", async () => {
		const directory = join(root, ".cursor");
		mkdirSync(directory);
		const path = join(directory, "hooks.json");
		writeFileSync(path, JSON.stringify({ version: 1, theme: "custom", hooks: {
			stop: [{ command: "./audit.sh" }, { command: "/old/dev3 hook cursor-usage" }],
		} }));
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		await handleRemoveCursorHooks(root);
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ version: 1, theme: "custom", hooks: { stop: [{ command: "./audit.sh" }] } });
	});

	it("does not create Cursor configuration when none exists", async () => {
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		await handleRemoveCursorHooks(root);
		expect(existsSync(join(root, ".cursor"))).toBe(false);
	});

	it("documents the removal option and its offline behavior", () => {
		const result = resolveHelp(["install-hooks", "--help"]);
		expect(result.action === "command" && result.text).toContain("dev3 install-hooks [--remove-cursor]");
	});
});

describe("install-hooks git exclusion", () => {
	const worktree = `${resolveDev3Home()}/worktrees/proj/abcd1234/worktree`;
	beforeEach(() => {
		vi.spyOn(process, "cwd").mockReturnValue(worktree);
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		vi.mocked(writeClaudeHooks).mockReturnValue({ written: true, skippedSymlink: null });
		vi.mocked(writeCodexHooks).mockReturnValue(null);
		vi.mocked(excludeTaskClaudeSettings).mockClear();
		vi.mocked(excludeTaskCodexHooks).mockClear();
	});
	afterEach(() => { vi.restoreAllMocks(); });

	it("excludes both hook files it wrote", async () => {
		await handleInstallHooks();
		expect(excludeTaskClaudeSettings).toHaveBeenCalledWith(worktree);
		expect(excludeTaskCodexHooks).toHaveBeenCalledWith(worktree);
	});

	it("skips the Claude exclusion when its settings path is a symlink", async () => {
		vi.mocked(writeClaudeHooks).mockReturnValue({ written: false, skippedSymlink: `${worktree}/.claude` });
		await handleInstallHooks();
		expect(excludeTaskClaudeSettings).not.toHaveBeenCalled();
		expect(excludeTaskCodexHooks).toHaveBeenCalledWith(worktree);
	});

	it("skips the Codex exclusion when its hooks path is a symlink", async () => {
		vi.mocked(writeCodexHooks).mockReturnValue(`${worktree}/.codex`);
		await handleInstallHooks();
		expect(excludeTaskCodexHooks).not.toHaveBeenCalled();
		expect(excludeTaskClaudeSettings).toHaveBeenCalledWith(worktree);
	});
});
