import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../spawn", () => ({
	spawn: vi.fn(),
	spawnSync: vi.fn(),
}));

import { detectRosetta, buildReinstallCommand, getRosettaWarningInfo } from "../rosetta";
import { spawnSync } from "../spawn";

const spawnSyncMock = vi.mocked(spawnSync);

function sysctlReturns(stdout: string, exitCode = 0): void {
	spawnSyncMock.mockReturnValue({
		success: exitCode === 0,
		exitCode,
		stdout: Buffer.from(stdout),
	} as unknown as ReturnType<typeof spawnSync>);
}

beforeEach(() => {
	spawnSyncMock.mockReset();
});

describe("detectRosetta", () => {
	it("returns true only when proc_translated is exactly 1", () => {
		sysctlReturns("1\n");
		expect(detectRosetta("darwin", "x64")).toBe(true);
	});

	it("returns false on a real Intel Mac (proc_translated = 0)", () => {
		sysctlReturns("0\n");
		expect(detectRosetta("darwin", "x64")).toBe(false);
	});

	it("returns false when the sysctl OID does not exist (old Intel Macs)", () => {
		sysctlReturns("", 1);
		expect(detectRosetta("darwin", "x64")).toBe(false);
	});

	it("returns false when sysctl throws", () => {
		spawnSyncMock.mockImplementation(() => {
			throw new Error("spawn failed");
		});
		expect(detectRosetta("darwin", "x64")).toBe(false);
	});

	it("never probes on native arm64", () => {
		expect(detectRosetta("darwin", "arm64")).toBe(false);
		expect(spawnSyncMock).not.toHaveBeenCalled();
	});

	it("never probes on non-macOS platforms", () => {
		expect(detectRosetta("linux", "x64")).toBe(false);
		expect(spawnSyncMock).not.toHaveBeenCalled();
	});
});

describe("buildReinstallCommand", () => {
	it("prefers the arm64 Homebrew cask with the real bundle path", () => {
		const { command, kind } = buildReinstallCommand(true, "/Applications/dev-3.0.app");

		expect(kind).toBe("brew");
		expect(command).toBe('rm -rf "/Applications/dev-3.0.app" && brew install --cask h0x91b/dev3/dev3');
	});

	it("falls back to the default bundle location when the running path is not an .app", () => {
		const { command } = buildReinstallCommand(true, "/opt/somewhere/bin");

		expect(command).toContain('rm -rf "/Applications/dev-3.0.app"');
	});

	it("falls back to the arm64 DMG when native Homebrew is absent", () => {
		const { command, kind } = buildReinstallCommand(false, "/Applications/dev-3.0.app");

		expect(kind).toBe("dmg");
		expect(command).toContain("stable-macos-arm64-dev-3.0.dmg");
		expect(command).toContain("open ~/Downloads/dev-3.0-arm64.dmg");
	});
});

describe("getRosettaWarningInfo", () => {
	it("returns null when not under Rosetta", () => {
		expect(getRosettaWarningInfo(false)).toBeNull();
	});

	it("returns a reinstall command under Rosetta", () => {
		const info = getRosettaWarningInfo(true);

		expect(info).not.toBeNull();
		expect(info?.command).toBeTruthy();
		expect(info?.kind === "brew" || info?.kind === "dmg").toBe(true);
	});
});
