import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const { spawnMock } = vi.hoisted(() => ({
	spawnMock: vi.fn(),
}));

vi.mock("../spawn", () => ({
	spawn: spawnMock,
}));

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

describe("shell environment bootstrap", () => {
	let originalShell: string | undefined;

	beforeEach(() => {
		originalShell = process.env.SHELL;
		vi.resetModules();
		spawnMock.mockReset();
	});

	afterEach(() => {
		process.env.SHELL = originalShell;
	});

	it("skips unsupported shells like fish instead of running bash/zsh login commands", async () => {
		process.env.SHELL = "/usr/local/bin/fish";

		const { resolveShellEnv } = await import("../shell-env");
		const result = await resolveShellEnv();

		expect(result).toEqual({});
		expect(spawnMock).not.toHaveBeenCalled();
	});

	it("main-process PATH bootstrap uses an explicit shell-profile helper instead of defaulting to zsh", () => {
		const indexPath = resolve(repoRoot, "src/bun/index.ts");
		expect(existsSync(indexPath)).toBe(true);

		const source = readFileSync(indexPath, "utf-8");

		expect(source).toContain("getShellRcFile");
		expect(source).not.toContain('const rcFile = shell.endsWith("bash") ? `${home}/.bashrc` : `${home}/.zshrc`;');
	});
});
