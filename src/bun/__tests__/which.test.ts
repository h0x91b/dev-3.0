import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../spawn", () => ({
	spawn: vi.fn(),
	spawnSync: vi.fn(),
}));

describe("which — PATH resolution", () => {
	let originalPath: string | undefined;
	const mockBunWhich = vi.fn();

	beforeEach(() => {
		originalPath = process.env.PATH;
		vi.resetModules();

		// Inject a fake Bun.which into the global so the module prefers it
		(globalThis as any).Bun = { which: mockBunWhich };
	});

	afterEach(() => {
		process.env.PATH = originalPath;
		delete (globalThis as any).Bun;
		mockBunWhich.mockReset();
	});

	it("whichSync and which pass process.env.PATH explicitly to Bun.which", async () => {
		process.env.PATH = "/custom/resolved/path:/usr/bin";
		mockBunWhich.mockReturnValue("/custom/resolved/path/tmux");

		const { whichSync } = await import("../which");

		const result = whichSync("tmux");

		expect(result).toBe("/custom/resolved/path/tmux");
		expect(mockBunWhich).toHaveBeenCalledWith("tmux", {
			PATH: "/custom/resolved/path:/usr/bin",
		});

		process.env.PATH = "/nix/store/bin:/usr/bin";
		mockBunWhich.mockReturnValue("/nix/store/bin/gh");

		const { which } = await import("../which");

		const asyncResult = await which("gh");

		expect(asyncResult).toBe("/nix/store/bin/gh");
		expect(mockBunWhich).toHaveBeenCalledWith("gh", {
			PATH: "/nix/store/bin:/usr/bin",
		});
	});

	it("whichSync reads process.env.PATH at call time, not import time, and returns null when Bun.which does", async () => {
		process.env.PATH = "/initial/path";
		mockBunWhich.mockReturnValue(null);

		const { whichSync } = await import("../which");

		// Simulate shell-env resolution updating PATH after module load
		process.env.PATH = "/resolved/shell/path:/usr/local/bin";
		mockBunWhich.mockReturnValue("/usr/local/bin/tmux");

		whichSync("tmux");

		expect(mockBunWhich).toHaveBeenCalledWith("tmux", {
			PATH: "/resolved/shell/path:/usr/local/bin",
		});

		mockBunWhich.mockReturnValue(null);
		expect(whichSync("nonexistent")).toBeNull();
	});
});
