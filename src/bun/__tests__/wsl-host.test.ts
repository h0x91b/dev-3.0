import { afterEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => ({
	spawn: vi.fn(),
	spawnSync: vi.fn(),
}));
vi.mock("../spawn", () => spawnMock);

import { isWslHost, openOnWindowsHost, resetWslHostCache } from "../wsl-host";

function syncResult(stdout: string, exitCode = 0) {
	return { exitCode, stdout: Buffer.from(stdout), stderr: Buffer.from("") };
}

afterEach(() => {
	vi.unstubAllEnvs();
	resetWslHostCache();
	spawnMock.spawn.mockReset();
	spawnMock.spawnSync.mockReset();
});

describe("isWslHost", () => {
	it("is true on Linux when WSL names the distro", () => {
		vi.stubEnv("WSL_DISTRO_NAME", "Ubuntu");
		expect(isWslHost()).toBe(process.platform === "linux");
	});
});

describe("openOnWindowsHost", () => {
	it("hands explorer.exe the \\\\wsl.localhost path of the file", () => {
		spawnMock.spawnSync.mockImplementation((cmd: string[]) => {
			if (cmd[0] === "wslpath") return syncResult("\\\\wsl.localhost\\Ubuntu\\home\\me\\spec.md\n");
			if (cmd[0] === "which") return syncResult("/usr/local/bin/explorer.exe\n");
			throw new Error(`unexpected ${cmd.join(" ")}`);
		});
		openOnWindowsHost("/home/me/spec.md");
		expect(spawnMock.spawnSync).toHaveBeenCalledWith(["wslpath", "-w", "/home/me/spec.md"], expect.anything());
		expect(spawnMock.spawn).toHaveBeenCalledWith(["/usr/local/bin/explorer.exe", "\\\\wsl.localhost\\Ubuntu\\home\\me\\spec.md"], expect.anything());
	});

	it("finds explorer.exe through the Windows drive when it is not on PATH", () => {
		spawnMock.spawnSync.mockImplementation((cmd: string[]) => {
			if (cmd[0] === "which") return syncResult("", 1);
			if (cmd[1] === "-u") return syncResult("/mnt/c/Windows\n");
			return syncResult("\\\\wsl.localhost\\Ubuntu\\x.html\n");
		});
		openOnWindowsHost("/x.html");
		expect(spawnMock.spawn).toHaveBeenCalledWith(["/mnt/c/Windows/explorer.exe", "\\\\wsl.localhost\\Ubuntu\\x.html"], expect.anything());
	});

	it("throws when the path cannot be converted, instead of opening nothing silently", () => {
		spawnMock.spawnSync.mockReturnValue(syncResult("", 1));
		expect(() => openOnWindowsHost("/x.html")).toThrow("wslpath failed");
		expect(spawnMock.spawn).not.toHaveBeenCalled();
	});
});
