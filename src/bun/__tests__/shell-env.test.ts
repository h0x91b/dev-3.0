import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const { spawnMock, spawnSyncMock } = vi.hoisted(() => ({
	spawnMock: vi.fn(),
	spawnSyncMock: vi.fn(),
}));

vi.mock("../spawn", () => ({
	spawn: spawnMock,
	spawnSync: spawnSyncMock,
}));

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

function fakeProc(stdout: string, stderr = "", exitCode = 0) {
	const encoder = new TextEncoder();
	return {
		exited: Promise.resolve(exitCode),
		stdout: new ReadableStream({
			start(controller) {
				controller.enqueue(encoder.encode(stdout));
				controller.close();
			},
		}),
		stderr: new ReadableStream({
			start(controller) {
				controller.enqueue(encoder.encode(stderr));
				controller.close();
			},
		}),
	};
}

describe("shell environment bootstrap", () => {
	let originalShell: string | undefined;
	let originalPlatform: string;

	beforeEach(() => {
		originalShell = process.env.SHELL;
		originalPlatform = process.platform;
		vi.resetModules();
		spawnMock.mockReset();
		spawnSyncMock.mockReset();
	});

	afterEach(() => {
		process.env.SHELL = originalShell;
		Object.defineProperty(process, "platform", { value: originalPlatform });
	});

	it("skips unsupported shells like fish instead of running bash/zsh login commands", async () => {
		process.env.SHELL = "/usr/local/bin/fish";

		const { resolveShellEnv } = await import("../shell-env");
		const result = await resolveShellEnv();

		expect(result).toEqual({});
		expect(spawnMock).not.toHaveBeenCalled();
	});

	it("captures gh-related config variables and SSH_AUTH_SOCK from the login shell", async () => {
		process.env.SHELL = "/bin/zsh";
		spawnMock.mockReturnValue(fakeProc([
			"___PATH=/opt/homebrew/bin:/usr/bin:/bin",
			"___LANG=en_US.UTF-8",
			"___XDG_CONFIG_HOME=/Users/tester/.config-xdg",
			"___GH_CONFIG_DIR=/Users/tester/.config-gh",
			"___SSH_AUTH_SOCK=/private/tmp/com.apple.launchd.abc/Listeners",
		].join("\n")));

		const { resolveShellEnv } = await import("../shell-env");
		const result = await resolveShellEnv();

		expect(result).toEqual({
			path: "/opt/homebrew/bin:/usr/bin:/bin",
			lang: "en_US.UTF-8",
			xdgConfigHome: "/Users/tester/.config-xdg",
			ghConfigDir: "/Users/tester/.config-gh",
			sshAuthSock: "/private/tmp/com.apple.launchd.abc/Listeners",
		});
	});

	it("prefers the account shell from macOS user records over a stale SHELL env", async () => {
		process.env.SHELL = "/bin/bash";
		Object.defineProperty(process, "platform", { value: "darwin" });
		spawnSyncMock.mockReturnValue({
			exitCode: 0,
			stdout: new TextEncoder().encode("UserShell: /bin/zsh\n"),
			stderr: new Uint8Array(),
		});
		spawnMock.mockReturnValue(fakeProc("___PATH=/opt/homebrew/bin:/usr/bin\n"));

		const { getUserShell, resolveShellEnv } = await import("../shell-env");
		expect(getUserShell()).toBe("/bin/zsh");

		await resolveShellEnv();

		expect(spawnMock).toHaveBeenCalledWith(
			expect.arrayContaining(["/bin/zsh", "-ilc"]),
			expect.any(Object),
		);
	});

	describe("getShellRcFiles", () => {
		const home = "/Users/tester";
		const none = () => false;

		it("includes a login profile for bash so login shells (macOS / tmux) get dev3 on PATH", async () => {
			const { getShellRcFiles } = await import("../shell-env");
			// Reproduces the reported bug: writing only to .bashrc leaves login
			// bash (which reads the login profile, not .bashrc) without dev3.
			const files = getShellRcFiles("/bin/bash", home, none);
			expect(files).toContain(`${home}/.bash_profile`);
			expect(files).toContain(`${home}/.bashrc`);
		});

		it("appends to an existing bash login profile instead of shadowing it", async () => {
			const { getShellRcFiles } = await import("../shell-env");
			// User has only ~/.profile — creating a fresh .bash_profile would
			// stop login bash from sourcing it, so we must reuse .profile.
			const onlyProfile = (p: string) => p === `${home}/.profile`;
			const files = getShellRcFiles("/bin/bash", home, onlyProfile);
			expect(files).toEqual([`${home}/.profile`, `${home}/.bashrc`]);
		});

		it("prefers .bash_profile over .bash_login and .profile when several exist", async () => {
			const { getShellRcFiles } = await import("../shell-env");
			const files = getShellRcFiles("/bin/bash", home, () => true);
			expect(files).toEqual([`${home}/.bash_profile`, `${home}/.bashrc`]);
		});

		it("uses only .zshrc for zsh (read by every interactive shell)", async () => {
			const { getShellRcFiles } = await import("../shell-env");
			expect(getShellRcFiles("/bin/zsh", home, none)).toEqual([`${home}/.zshrc`]);
		});

		it("returns no files for unsupported shells like fish", async () => {
			const { getShellRcFiles } = await import("../shell-env");
			expect(getShellRcFiles("/usr/local/bin/fish", home, none)).toEqual([]);
		});
	});

	it("main-process PATH bootstrap uses an explicit shell-profile helper instead of defaulting to zsh", () => {
		const indexPath = resolve(repoRoot, "src/bun/index.ts");
		expect(existsSync(indexPath)).toBe(true);

		const source = readFileSync(indexPath, "utf-8");

		expect(source).toContain("getShellRcFile");
		expect(source).not.toContain('const rcFile = shell.endsWith("bash") ? `${home}/.bashrc` : `${home}/.zshrc`;');
	});
});
