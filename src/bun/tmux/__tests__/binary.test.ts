import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Shim/binary-selection tests moved verbatim from pty-server.test.ts together
// with the code (decision: the v1.29.1 ELOOP incident coverage travels with
// the module, see src/bun/tmux/binary.ts).

// ---- Mocks (hoisted before imports) ----

vi.mock("../../logger", () => ({
	createLogger: () => ({
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	}),
}));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		accessSync: vi.fn(),
		existsSync: vi.fn(() => true),
		writeFileSync: vi.fn(),
		// Shim-management fns (updateTmuxShim) must never touch the real
		// ~/.dev3.0/bin of whoever runs the tests.
		mkdirSync: vi.fn(),
		lstatSync: vi.fn(() => { throw new Error("ENOENT"); }),
		statSync: vi.fn(() => ({ isFile: () => true })),
		readlinkSync: vi.fn(() => { throw new Error("EINVAL"); }),
		realpathSync: vi.fn((p: string) => p),
		unlinkSync: vi.fn(),
		symlinkSync: vi.fn(),
	};
});

vi.mock("../../spawn", () => ({
	spawn: vi.fn(),
	spawnSync: vi.fn(),
}));

// ---- Imports ----

import { accessSync, existsSync, lstatSync, statSync, readlinkSync, realpathSync, unlinkSync, symlinkSync } from "node:fs";
import { spawn } from "../../spawn";
import { DEV3_HOME } from "../../paths";
import {
	selectTmuxBinary,
	updateTmuxShim,
	dereferenceTmuxShim,
	sanitizeTmuxShim,
	probeTmuxVersion,
	TMUX_SHIM_PATH,
	getTmuxBinary,
	setTmuxBinary,
} from "../binary";

const mockSpawn = vi.mocked(spawn);
const mockExistsSync = vi.mocked(existsSync);

beforeEach(() => {
	vi.clearAllMocks();
	mockExistsSync.mockReturnValue(true);
	vi.mocked(lstatSync).mockImplementation(() => { throw new Error("ENOENT"); });
	vi.mocked(statSync).mockReturnValue({ isFile: () => true } as any);
	vi.mocked(readlinkSync).mockImplementation(() => { throw new Error("EINVAL"); });
	vi.mocked(realpathSync).mockImplementation(((p: string) => p) as any);
	vi.mocked(accessSync).mockImplementation(() => undefined);
});

describe("probeTmuxVersion", () => {
	it("returns the version string for a real tmux", async () => {
		mockSpawn.mockReturnValue({ exited: Promise.resolve(0), stdout: "tmux 3.6a\n", stderr: "" } as any);
		expect(await probeTmuxVersion("/opt/homebrew/bin/tmux")).toBe("tmux 3.6a");
	});

	it("returns undefined for a binary that is not tmux", async () => {
		mockSpawn.mockReturnValue({ exited: Promise.resolve(0), stdout: "true (GNU coreutils)\n", stderr: "" } as any);
		expect(await probeTmuxVersion("/usr/bin/true")).toBeUndefined();
	});

	it("returns undefined when the probe cannot even spawn", async () => {
		mockSpawn.mockImplementation(() => { throw new Error("ENOENT"); });
		expect(await probeTmuxVersion("/missing/tmux")).toBeUndefined();
	});
});

// ---- tmux binary selection (pinned tmux@3.6 rollout) ----

describe("selectTmuxBinary", () => {
	const PREFERRED = "/opt/homebrew/opt/tmux@3.6/bin/tmux";
	const PATH_TMUX = "/opt/homebrew/bin/tmux";

	function probeResult(exitCode: number, stderr = "") {
		return { exited: Promise.resolve(exitCode), stderr, stdout: "tmux 3.6a\n" } as any;
	}

	function mockVersionAndServer(serverExitCode: number, stderr = "") {
		mockSpawn.mockImplementation(((args: string[]) =>
			args[1] === "-V" ? probeResult(0) : probeResult(serverExitCode, stderr)) as any);
	}

	afterEach(() => {
		setTmuxBinary("tmux");
	});

	it("keeps the preferred binary when no server is running", async () => {
		mockVersionAndServer(1, "no server running on /tmp/tmux-501/dev3");
		const chosen = await selectTmuxBinary(PREFERRED, [PATH_TMUX]);
		expect(chosen).toBe(PREFERRED);
		expect(getTmuxBinary()).toBe(PREFERRED);
		// One probe only — no fallback scanning when there is no server at all.
		const probes = mockSpawn.mock.calls.filter((c) => (c[0] as string[]).includes("list-sessions"));
		expect(probes).toHaveLength(1);
	});

	it("keeps the preferred binary when the running server accepts it", async () => {
		mockSpawn.mockReturnValue(probeResult(0, ""));
		const chosen = await selectTmuxBinary(PREFERRED, [PATH_TMUX]);
		expect(chosen).toBe(PREFERRED);
		expect(getTmuxBinary()).toBe(PREFERRED);
	});

	it("falls back to a candidate that can talk to a version-mismatched server", async () => {
		mockSpawn.mockImplementation(((args: string[]) =>
			args[1] === "-V"
				? probeResult(0)
				: args[0] === PREFERRED
				? probeResult(1, "server exited unexpectedly")
				: probeResult(0, "")) as any);
		const chosen = await selectTmuxBinary(PREFERRED, [PATH_TMUX]);
		expect(chosen).toBe(PATH_TMUX);
		expect(getTmuxBinary()).toBe(PATH_TMUX);
	});

	it("keeps the preferred binary when every candidate is incompatible", async () => {
		mockVersionAndServer(1, "server exited unexpectedly");
		const chosen = await selectTmuxBinary(PREFERRED, [PATH_TMUX, "/usr/local/bin/tmux"]);
		expect(chosen).toBe(PREFERRED);
		expect(getTmuxBinary()).toBe(PREFERRED);
	});

	it("skips fallback candidates that do not exist on disk", async () => {
		mockVersionAndServer(1, "server exited unexpectedly");
		mockExistsSync.mockImplementation((path) => path === PREFERRED);
		await selectTmuxBinary(PREFERRED, [PATH_TMUX]);
		const probes = mockSpawn.mock.calls.filter((c) => (c[0] as string[]).includes("list-sessions"));
		expect(probes).toHaveLength(1); // only the preferred binary was probed
	});

	it("dereferences the PATH shim instead of committing it (ELOOP regression)", async () => {
		// ~/.dev3.0/bin is first in PATH, so whichSync can hand us our own shim
		// as "preferred". Committing it and then repointing the shim at it
		// created a self-referential symlink that broke every tmux spawn.
		mockSpawn.mockReturnValue(probeResult(0, ""));
		mockExistsSync.mockReturnValue(true);
		vi.mocked(lstatSync).mockReturnValue({ isSymbolicLink: () => true } as any);
		vi.mocked(readlinkSync).mockReturnValue(PATH_TMUX);
		vi.mocked(realpathSync).mockReturnValue(PATH_TMUX);
		const chosen = await selectTmuxBinary(TMUX_SHIM_PATH, [TMUX_SHIM_PATH]);
		expect(chosen).toBe(PATH_TMUX);
		expect(getTmuxBinary()).toBe(PATH_TMUX);
		expect(vi.mocked(symlinkSync)).not.toHaveBeenCalledWith(TMUX_SHIM_PATH, TMUX_SHIM_PATH);
	});

	it("rejects a PATH shim that resolves to a directory and uses a real fallback", async () => {
		const HOME_DIR = "/Users/tester";
		mockVersionAndServer(1, "no server running on /tmp/tmux-501/dev3");
		mockExistsSync.mockReturnValue(true);
		vi.mocked(lstatSync).mockReturnValue({ isSymbolicLink: () => true } as any);
		vi.mocked(readlinkSync).mockReturnValue(HOME_DIR);
		vi.mocked(realpathSync).mockReturnValue(HOME_DIR);
		vi.mocked(statSync).mockImplementation(((path: string) => ({ isFile: () => path !== HOME_DIR })) as any);

		const chosen = await selectTmuxBinary(TMUX_SHIM_PATH, [PATH_TMUX]);

		expect(chosen).toBe(PATH_TMUX);
		expect(getTmuxBinary()).toBe(PATH_TMUX);
		expect(vi.mocked(unlinkSync)).toHaveBeenCalledWith(TMUX_SHIM_PATH);
	});

	it("rejects an executable that is not tmux and uses a real fallback", async () => {
		const WRONG_BINARY = "/usr/bin/true";
		mockExistsSync.mockReturnValue(true);
		mockSpawn.mockImplementation(((args: string[]) => {
			if (args[1] === "-V") {
				return args[0] === WRONG_BINARY
					? { exited: Promise.resolve(0), stdout: "true (GNU coreutils) 9.5\n", stderr: "" }
					: { exited: Promise.resolve(0), stdout: "tmux 3.6a\n", stderr: "" };
			}
			return probeResult(1, "no server running on /tmp/tmux-501/dev3");
		}) as any);

		const chosen = await selectTmuxBinary(WRONG_BINARY, [PATH_TMUX]);

		expect(chosen).toBe(PATH_TMUX);
		expect(getTmuxBinary()).toBe(PATH_TMUX);
	});

	it("returns undefined instead of committing an executable that is not tmux", async () => {
		mockSpawn.mockReturnValue({
			exited: Promise.resolve(0),
			stdout: "not tmux\n",
			stderr: "",
		} as any);

		const chosen = await selectTmuxBinary("/usr/bin/true", ["/usr/bin/false"]);

		expect(chosen).toBeUndefined();
		expect(getTmuxBinary()).toBe("tmux");
		expect(vi.mocked(symlinkSync)).not.toHaveBeenCalled();
	});
});

describe("dereferenceTmuxShim", () => {
	const PATH_TMUX = "/opt/homebrew/bin/tmux";

	it("passes through non-shim paths untouched", () => {
		expect(dereferenceTmuxShim(PATH_TMUX)).toBe(PATH_TMUX);
	});

	it("resolves the shim to its symlink target", () => {
		vi.mocked(lstatSync).mockReturnValue({ isSymbolicLink: () => true } as any);
		vi.mocked(realpathSync).mockReturnValue(PATH_TMUX);
		vi.mocked(readlinkSync).mockReturnValue(PATH_TMUX);
		expect(dereferenceTmuxShim(TMUX_SHIM_PATH)).toBe(PATH_TMUX);
	});

	it("removes a broken/cyclic shim and returns undefined", () => {
		vi.mocked(lstatSync).mockReturnValue({ isSymbolicLink: () => true } as any);
		vi.mocked(realpathSync).mockImplementation(() => { throw new Error("ELOOP"); });
		expect(dereferenceTmuxShim(TMUX_SHIM_PATH)).toBeUndefined();
		expect(vi.mocked(unlinkSync)).toHaveBeenCalledWith(TMUX_SHIM_PATH);
	});

	it("leaves a regular file at the shim path alone and uses it as-is", () => {
		// The app only ever creates a symlink there — a regular file is the
		// user's own binary and must never be deleted.
		vi.mocked(lstatSync).mockReturnValue({ isSymbolicLink: () => false } as any);
		mockExistsSync.mockReturnValue(true);
		expect(dereferenceTmuxShim(TMUX_SHIM_PATH)).toBe(TMUX_SHIM_PATH);
		expect(vi.mocked(unlinkSync)).not.toHaveBeenCalled();
	});

	it("returns undefined for a missing shim path that is not a symlink", () => {
		vi.mocked(lstatSync).mockImplementation(() => { throw new Error("ENOENT"); });
		mockExistsSync.mockReturnValue(false);
		expect(dereferenceTmuxShim(TMUX_SHIM_PATH)).toBeUndefined();
		expect(vi.mocked(unlinkSync)).not.toHaveBeenCalled();
	});
});

describe("sanitizeTmuxShim", () => {
	it("removes the shim when the symlink cannot be resolved (ELOOP)", () => {
		vi.mocked(lstatSync).mockReturnValue({ isSymbolicLink: () => true } as any);
		vi.mocked(realpathSync).mockImplementation(() => { throw new Error("ELOOP"); });
		sanitizeTmuxShim();
		expect(vi.mocked(unlinkSync)).toHaveBeenCalledWith(TMUX_SHIM_PATH);
	});

	it("keeps a healthy shim", () => {
		vi.mocked(lstatSync).mockReturnValue({ isSymbolicLink: () => true } as any);
		vi.mocked(realpathSync).mockReturnValue("/opt/homebrew/bin/tmux");
		sanitizeTmuxShim();
		expect(vi.mocked(unlinkSync)).not.toHaveBeenCalled();
	});

	it("ignores a non-symlink file", () => {
		vi.mocked(lstatSync).mockReturnValue({ isSymbolicLink: () => false } as any);
		sanitizeTmuxShim();
		expect(vi.mocked(unlinkSync)).not.toHaveBeenCalled();
	});
});

describe("updateTmuxShim", () => {
	const TARGET = "/opt/homebrew/opt/tmux@3.6/bin/tmux";
	const SHIM = `${DEV3_HOME}/bin/tmux`;
	const mockLstatSync = vi.mocked(lstatSync);
	const mockReadlinkSync = vi.mocked(readlinkSync);
	const mockUnlinkSync = vi.mocked(unlinkSync);
	const mockSymlinkSync = vi.mocked(symlinkSync);

	beforeEach(() => {
		mockExistsSync.mockReturnValue(true);
		vi.mocked(statSync).mockReturnValue({ isFile: () => true } as any);
		vi.mocked(accessSync).mockImplementation(() => undefined);
	});

	it("does nothing for a bare binary name", () => {
		updateTmuxShim("tmux");
		expect(mockSymlinkSync).not.toHaveBeenCalled();
		expect(mockUnlinkSync).not.toHaveBeenCalled();
	});

	it("creates the symlink when missing", () => {
		mockExistsSync.mockImplementation((path) => path === TARGET);
		mockLstatSync.mockImplementation(() => { throw new Error("ENOENT"); });
		updateTmuxShim(TARGET);
		expect(mockSymlinkSync).toHaveBeenCalledWith(TARGET, SHIM);
	});

	it("refuses to create a shim for a directory", () => {
		const directory = "/Users/tester";
		mockExistsSync.mockReturnValue(true);
		vi.mocked(statSync).mockReturnValue({ isFile: () => false } as any);

		updateTmuxShim(directory);

		expect(mockUnlinkSync).not.toHaveBeenCalled();
		expect(mockSymlinkSync).not.toHaveBeenCalled();
	});

	it("leaves a pre-existing non-symlink file alone", () => {
		mockExistsSync.mockReturnValue(true);
		mockLstatSync.mockReturnValue({ isSymbolicLink: () => false } as any);
		updateTmuxShim(TARGET);
		expect(mockUnlinkSync).not.toHaveBeenCalled();
		expect(mockSymlinkSync).not.toHaveBeenCalled();
	});

	it("repoints the symlink when it targets a different binary", () => {
		mockExistsSync.mockReturnValue(true);
		mockLstatSync.mockReturnValue({ isSymbolicLink: () => true } as any);
		mockReadlinkSync.mockReturnValue("/old/path/tmux");
		updateTmuxShim(TARGET);
		expect(mockUnlinkSync).toHaveBeenCalledWith(SHIM);
		expect(mockSymlinkSync).toHaveBeenCalledWith(TARGET, SHIM);
	});

	it("is a no-op when the symlink already points at the binary", () => {
		mockExistsSync.mockReturnValue(true);
		mockLstatSync.mockReturnValue({ isSymbolicLink: () => true } as any);
		mockReadlinkSync.mockReturnValue(TARGET);
		updateTmuxShim(TARGET);
		expect(mockUnlinkSync).not.toHaveBeenCalled();
		expect(mockSymlinkSync).not.toHaveBeenCalled();
	});

	it("refuses to point the shim at itself (ELOOP regression)", () => {
		mockExistsSync.mockReturnValue(true);
		mockLstatSync.mockReturnValue({ isSymbolicLink: () => true } as any);
		mockReadlinkSync.mockReturnValue("/opt/homebrew/bin/tmux");
		updateTmuxShim(SHIM);
		expect(mockUnlinkSync).not.toHaveBeenCalled();
		expect(mockSymlinkSync).not.toHaveBeenCalled();
	});
});
