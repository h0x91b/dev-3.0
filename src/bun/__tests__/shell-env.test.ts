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

	// awk output: sentinel + null-delimited KEY=VALUE\0 pairs.
	// The sentinel lets parseNullDelimitedEnv discard login-shell startup noise.
	function nullEnv(vars: Record<string, string>): string {
		return "\x01\x01DEV3ENV\x01\x01" + Object.entries(vars).map(([k, v]) => `${k}=${v}\0`).join("");
	}

	it("captures typed config vars plus the full exported env from the login shell", async () => {
		process.env.SHELL = "/bin/zsh";
		spawnMock.mockReturnValue(fakeProc(nullEnv({
			PATH: "/opt/homebrew/bin:/usr/bin:/bin",
			LANG: "en_US.UTF-8",
			XDG_CONFIG_HOME: "/Users/tester/.config-xdg",
			GH_CONFIG_DIR: "/Users/tester/.config-gh",
			SSH_AUTH_SOCK: "/private/tmp/com.apple.launchd.abc/Listeners",
			MDB_MCP_CONNECTION_STRING: "mongodb://user:pass@host/db",
			DD_API_KEY: "secret-key",
		})));

		const { resolveShellEnv } = await import("../shell-env");
		const result = await resolveShellEnv();

		expect(result.path).toBe("/opt/homebrew/bin:/usr/bin:/bin");
		expect(result.lang).toBe("en_US.UTF-8");
		expect(result.xdgConfigHome).toBe("/Users/tester/.config-xdg");
		expect(result.ghConfigDir).toBe("/Users/tester/.config-gh");
		expect(result.sshAuthSock).toBe("/private/tmp/com.apple.launchd.abc/Listeners");
		// User-exported credentials flow through fullEnv...
		expect(result.fullEnv).toEqual({
			MDB_MCP_CONNECTION_STRING: "mongodb://user:pass@host/db",
			DD_API_KEY: "secret-key",
		});
		// ...but the typed vars are NOT duplicated into fullEnv (owned by bootstrap).
		expect(result.fullEnv).not.toHaveProperty("PATH");
		expect(result.fullEnv).not.toHaveProperty("LANG");
		expect(result.fullEnv).not.toHaveProperty("SSH_AUTH_SOCK");
	});

	it("excludes runtime/internal vars from fullEnv (denylist + prefixes)", async () => {
		process.env.SHELL = "/bin/zsh";
		spawnMock.mockReturnValue(fakeProc(nullEnv({
			MY_TOKEN: "keep-me",
			SHLVL: "3",
			PWD: "/somewhere",
			OLDPWD: "/elsewhere",
			_: "/usr/bin/awk",
			SHELL: "/bin/zsh",
			TERM: "xterm-256color",
			TMPDIR: "/var/folders/xx/T/",
			DEV3_TASK_ID: "abc123",
			BUN_INSTALL: "/Users/tester/.bun",
		})));

		const { resolveShellEnv } = await import("../shell-env");
		const result = await resolveShellEnv();

		expect(result.fullEnv).toEqual({ MY_TOKEN: "keep-me" });
	});

	it("preserves multiline and '=' containing env values", async () => {
		process.env.SHELL = "/bin/zsh";
		spawnMock.mockReturnValue(fakeProc(nullEnv({
			MULTILINE_KEY: "-----BEGIN-----\nline2\nline3\n-----END-----",
			URL_WITH_EQUALS: "https://x.test/?a=1&b=2",
		})));

		const { resolveShellEnv } = await import("../shell-env");
		const result = await resolveShellEnv();

		expect(result.fullEnv?.MULTILINE_KEY).toBe("-----BEGIN-----\nline2\nline3\n-----END-----");
		expect(result.fullEnv?.URL_WITH_EQUALS).toBe("https://x.test/?a=1&b=2");
	});

	it("strips login-shell startup noise that precedes the awk sentinel", async () => {
		process.env.SHELL = "/bin/zsh";
		// Simulate .zshrc that echoes a welcome banner to stdout before awk runs.
		const noise = "Welcome!\nsome=junk\n";
		spawnMock.mockReturnValue(fakeProc(noise + nullEnv({ MY_API_KEY: "secret" })));

		const { resolveShellEnv } = await import("../shell-env");
		const result = await resolveShellEnv();

		expect(result.fullEnv?.MY_API_KEY).toBe("secret");
		expect(Object.keys(result.fullEnv ?? {})).toHaveLength(1);
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
