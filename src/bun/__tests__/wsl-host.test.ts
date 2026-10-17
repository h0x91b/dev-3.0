import { afterEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => ({
	spawn: vi.fn(),
	spawnSync: vi.fn(),
}));
vi.mock("../spawn", () => spawnMock);
const whichMock = vi.hoisted(() => ({ whichSync: vi.fn<(command: string) => string | null>() }));
vi.mock("../which", () => whichMock);
const fsMock = vi.hoisted(() => ({ existing: new Set<string>() }));
vi.mock("node:fs", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:fs")>()),
	existsSync: (path: string) => fsMock.existing.has(path),
}));

import { isWslHost, openOnWindowsHost, resetWslHostCache } from "../wsl-host";

function syncResult(stdout: string, exitCode = 0) {
	return { exitCode, stdout: Buffer.from(stdout), stderr: Buffer.from("") };
}

function exitingWith(code: number) {
	return { exited: Promise.resolve(code) };
}

afterEach(() => {
	resetWslHostCache();
	fsMock.existing.clear();
	spawnMock.spawn.mockReset();
	spawnMock.spawnSync.mockReset();
	whichMock.whichSync.mockReset();
});

describe("isWslHost", () => {
	it("needs WSL interop registered, under either of its names", () => {
		if (process.platform !== "linux") return;
		expect(isWslHost()).toBe(false);
		resetWslHostCache();
		fsMock.existing.add("/proc/sys/fs/binfmt_misc/WSLInterop-late");
		expect(isWslHost()).toBe(true);
	});

	it("is false off Linux whatever the filesystem says", () => {
		if (process.platform === "linux") return;
		fsMock.existing.add("/proc/sys/fs/binfmt_misc/WSLInterop");
		expect(isWslHost()).toBe(false);
	});
});

describe("openOnWindowsHost", () => {
	it("hands the path to PowerShell through a WSLENV-translated variable, never as an argument", async () => {
		whichMock.whichSync.mockReturnValue("/win/powershell.exe");
		spawnMock.spawn.mockReturnValue(exitingWith(0));
		await openOnWindowsHost("/home/me/a,b c.md");
		const [cmd, opts] = spawnMock.spawn.mock.calls[0] as [string[], { env: Record<string, string> }];
		expect(cmd[0]).toBe("/win/powershell.exe");
		expect(cmd.join(" ")).not.toContain("a,b c.md");
		expect(cmd[cmd.length - 1]).toBe("Invoke-Item -LiteralPath $env:DEV3_OPEN_PATH");
		expect(opts.env.DEV3_OPEN_PATH).toBe("/home/me/a,b c.md");
		expect(opts.env.WSLENV.split(":")).toContain("DEV3_OPEN_PATH/p");
	});

	it("finds PowerShell through the Windows drive when it is not on PATH", async () => {
		whichMock.whichSync.mockReturnValue(null);
		spawnMock.spawnSync.mockReturnValue(syncResult("/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe\n"));
		spawnMock.spawn.mockReturnValue(exitingWith(0));
		await openOnWindowsHost("/x.html");
		expect(spawnMock.spawnSync.mock.calls[0][0]).toEqual(["wslpath", "-u", "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"]);
		expect((spawnMock.spawn.mock.calls[0][0] as string[])[0]).toBe("/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe");
	});

	it("gives up and stops PowerShell when Windows does not answer", async () => {
		vi.useFakeTimers();
		try {
			whichMock.whichSync.mockReturnValue("/win/powershell.exe");
			const kill = vi.fn();
			spawnMock.spawn.mockReturnValue({ exited: new Promise<number>(() => {}), kill });
			const opening = expect(openOnWindowsHost("/x.html")).rejects.toThrow("Windows did not respond");
			await vi.advanceTimersByTimeAsync(15_000);
			await opening;
			expect(kill).toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	it("reports a failure instead of claiming the file opened", async () => {
		whichMock.whichSync.mockReturnValue("/win/powershell.exe");
		spawnMock.spawn.mockReturnValue(exitingWith(1));
		await expect(openOnWindowsHost("/x.html")).rejects.toThrow("Windows could not open the file");
		whichMock.whichSync.mockReturnValue(null);
		spawnMock.spawnSync.mockReturnValue(syncResult("", 1));
		await expect(openOnWindowsHost("/x.html")).rejects.toThrow("PowerShell not found");
	});
});
