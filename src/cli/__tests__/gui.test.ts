import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handleGui } from "../commands/gui";
import type { ParsedArgs } from "../args";

/**
 * `handleGui` spawns child processes (`open`, `tar`, `ldd`, `which`, the
 * launcher) and may call `fetch()` to download the Linux bundle. We mock all
 * of those so the tests run hermetically. `process.exit` is spied on so
 * exitError() raises synchronously instead of tearing the test runner down.
 */
type SpawnSyncResult = { status: number | null; stdout: string; stderr: string };
type SpawnSyncHandler = (args: readonly string[]) => SpawnSyncResult;

interface FsState {
	existing: Set<string>;
	written: Map<string, string | Uint8Array>;
}

interface SpawnState {
	calls: Array<{ cmd: string; args: readonly string[] }>;
	syncCalls: Array<{ cmd: string; args: readonly string[] }>;
	syncHandlers: Map<string, SpawnSyncResult | SpawnSyncHandler>;
}

let fsState: FsState;
let spawnState: SpawnState;

vi.mock("node:fs", () => ({
	existsSync: (p: string) => fsState.existing.has(p),
	mkdirSync: () => {},
	writeFileSync: (p: string, contents: string | Uint8Array) => {
		fsState.written.set(p, contents);
		fsState.existing.add(p);
	},
	chmodSync: () => {},
	unlinkSync: (p: string) => {
		fsState.existing.delete(p);
		fsState.written.delete(p);
	},
	readFileSync: (p: string, _enc?: string) => {
		const v = fsState.written.get(p);
		if (typeof v === "string") return v;
		if (v instanceof Uint8Array) return new TextDecoder().decode(v);
		throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
	},
}));

vi.mock("node:child_process", () => ({
	// `spawn` returns a stub child whose `on` never fires. We don't want to
	// trigger the "child exited" path inside handleGui because that would call
	// process.exit() asynchronously and tear down the test runner. Tests assert
	// that spawn was called for the right binary; that's all we need.
	spawn: (cmd: string, args: readonly string[] = []) => {
		spawnState.calls.push({ cmd, args });
		const child = {
			on: () => child,
			kill: () => {},
		};
		return child;
	},
	spawnSync: (cmd: string, args: readonly string[] = []) => {
		spawnState.syncCalls.push({ cmd, args });
		const handler = spawnState.syncHandlers.get(cmd);
		if (typeof handler === "function") return handler(args);
		if (handler) return handler;
		return { status: 0, stdout: "", stderr: "" };
	},
}));

function args(flags: Record<string, string> = {}, positional: string[] = []): ParsedArgs {
	return { positional, flags };
}

let exitSpy: ReturnType<typeof vi.spyOn>;
let stderrSpy: ReturnType<typeof vi.spyOn>;
let stdoutSpy: ReturnType<typeof vi.spyOn>;
let originalPlatform: PropertyDescriptor | undefined;

function setPlatform(value: NodeJS.Platform): void {
	originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
	Object.defineProperty(process, "platform", { value, configurable: true });
}

function restorePlatform(): void {
	if (originalPlatform) {
		Object.defineProperty(process, "platform", originalPlatform);
		originalPlatform = undefined;
	}
}

let sigIntBefore = 0;
let sigTermBefore = 0;

beforeEach(() => {
	fsState = { existing: new Set(), written: new Map() };
	spawnState = {
		calls: [],
		syncCalls: [],
		syncHandlers: new Map(),
	};
	exitSpy = vi.spyOn(process, "exit").mockImplementation(((_code?: number) => {
		throw new Error("__exit__");
	}) as never);
	stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
	stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
	sigIntBefore = process.listenerCount("SIGINT");
	sigTermBefore = process.listenerCount("SIGTERM");
});

afterEach(() => {
	exitSpy.mockRestore();
	stderrSpy.mockRestore();
	stdoutSpy.mockRestore();
	restorePlatform();
	// `handleGui` registers SIGINT/SIGTERM forwarders when it execs the launcher.
	// In tests the child never exits, so those listeners would leak across tests.
	const sigInt = process.listeners("SIGINT");
	for (let i = sigInt.length - 1; i >= sigIntBefore; i--) process.removeListener("SIGINT", sigInt[i]);
	const sigTerm = process.listeners("SIGTERM");
	for (let i = sigTerm.length - 1; i >= sigTermBefore; i--) process.removeListener("SIGTERM", sigTerm[i]);
	vi.clearAllMocks();
	delete process.env.DEV3_GUI_BUNDLE_URL;
	delete process.env.DEV3_GUI_BUNDLE_PATH;
});

function combinedStdout(): string {
	return stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("");
}

function combinedStderr(): string {
	return stderrSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("");
}

describe("dev3 gui — argument validation", () => {
	it("prints help on --help and returns without exiting", async () => {
		await handleGui(undefined, args({ help: "true" }));
		expect(combinedStdout()).toContain("dev3 gui — launch the dev-3.0 desktop app");
		expect(exitSpy).not.toHaveBeenCalled();
	});

	it("rejects unknown flags", async () => {
		await expect(handleGui(undefined, args({ bogus: "true" }))).rejects.toThrow("__exit__");
		expect(combinedStderr()).toContain("Unknown option: --bogus");
	});

	it("rejects positional arguments", async () => {
		await expect(handleGui(undefined, args({}, ["foo"]))).rejects.toThrow("__exit__");
		expect(combinedStderr()).toContain('Unknown positional argument: "foo"');
	});

	it("rejects subcommands", async () => {
		await expect(handleGui("install", args())).rejects.toThrow("__exit__");
		expect(combinedStderr()).toContain('"dev3 gui" takes no subcommand');
	});
});

describe("dev3 gui — macOS path", () => {
	beforeEach(() => setPlatform("darwin"));

	it("opens /Applications/dev-3.0.app when present", async () => {
		fsState.existing.add("/Applications/dev-3.0.app");
		await handleGui(undefined, args());
		const openCall = spawnState.syncCalls.find((c) => c.cmd === "open");
		expect(openCall).toBeDefined();
		expect(openCall?.args).toEqual(["-a", "/Applications/dev-3.0.app"]);
	});

	it("falls back to ~/Applications when /Applications is empty", async () => {
		const home = "/home/test-user";
		const original = process.env.HOME;
		process.env.HOME = home;
		fsState.existing.add(`${home}/Applications/dev-3.0.app`);
		try {
			await handleGui(undefined, args());
			const openCall = spawnState.syncCalls.find((c) => c.cmd === "open");
			expect(openCall?.args).toEqual(["-a", `${home}/Applications/dev-3.0.app`]);
		} finally {
			if (original === undefined) delete process.env.HOME;
			else process.env.HOME = original;
		}
	});

	it("prints a friendly cask hint when the app is not installed", async () => {
		await expect(handleGui(undefined, args())).rejects.toThrow("__exit__");
		expect(combinedStderr()).toContain("dev-3.0 desktop app not found");
		expect(combinedStderr()).toContain("brew install --cask dev3");
	});

	it("does not call fetch on macOS", async () => {
		fsState.existing.add("/Applications/dev-3.0.app");
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
			throw new Error("fetch should never be called on macOS");
		});
		try {
			await handleGui(undefined, args());
			expect(fetchSpy).not.toHaveBeenCalled();
		} finally {
			fetchSpy.mockRestore();
		}
	});
});

describe("dev3 gui — Linux path", () => {
	const home = "/home/test-user";
	const bundleRoot = `${home}/.dev3.0/gui/dev-3.0`;
	const launcher = `${bundleRoot}/bin/launcher`;
	const libNative = `${bundleRoot}/bin/libNativeWrapper.so`;
	let originalHome: string | undefined;

	beforeEach(() => {
		setPlatform("linux");
		originalHome = process.env.HOME;
		process.env.HOME = home;
	});

	afterEach(() => {
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;
	});

	it("execs the launcher when bundle is present and ldd reports nothing missing", async () => {
		fsState.existing.add(launcher);
		fsState.existing.add(libNative);
		spawnState.syncHandlers.set("ldd", {
			status: 0,
			stdout: "\tlibwebkit2gtk-4.1.so.0 => /lib/x86_64-linux-gnu/libwebkit2gtk-4.1.so.0 (0x...)\n",
			stderr: "",
		});

		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope"));

		try {
			// handleGui resolves once it has registered the exit handler on the
			// spawned launcher. Our spawn mock never fires "exit", so the call
			// returns normally — the real CLI would only exit when the launcher
			// process exits.
			await handleGui(undefined, args());
			expect(fetchSpy).not.toHaveBeenCalled();
			const launcherCall = spawnState.calls.find((c) => c.cmd === launcher);
			expect(launcherCall).toBeDefined();
		} finally {
			fetchSpy.mockRestore();
		}
	});

	it("prints distro-specific install command and exits 5 when libs are missing", async () => {
		fsState.existing.add(launcher);
		fsState.existing.add(libNative);
		fsState.existing.add("/etc/os-release");
		fsState.written.set("/etc/os-release", 'ID=ubuntu\nID_LIKE="debian"\nPRETTY_NAME="Ubuntu 24.04"\n');

		spawnState.syncHandlers.set("ldd", {
			status: 0,
			stdout: "\tlibwebkit2gtk-4.1.so.0 => not found\n\tlibcairo.so.2 => not found\n",
			stderr: "",
		});

		await expect(handleGui(undefined, args())).rejects.toThrow("__exit__");
		const err = combinedStderr();
		expect(err).toContain("system libraries are missing");
		expect(err).toContain("libwebkit2gtk-4.1.so.0");
		expect(err).toContain("libcairo.so.2");
		expect(err).toContain("sudo apt install -y");
		expect(err).toContain("libwebkit2gtk-4.1-0");
		expect(exitSpy).toHaveBeenCalledWith(5);
	});

	it("prints a generic hint when the distro cannot be detected", async () => {
		fsState.existing.add(launcher);
		fsState.existing.add(libNative);
		// /etc/os-release is intentionally absent.
		spawnState.syncHandlers.set("ldd", {
			status: 0,
			stdout: "\tlibwebkit2gtk-4.1.so.0 => not found\n",
			stderr: "",
		});

		await expect(handleGui(undefined, args())).rejects.toThrow("__exit__");
		const err = combinedStderr();
		expect(err).toContain("Install equivalents of");
		expect(err).toContain("libwebkit2gtk-4.1");
	});

	it("downloads, extracts and exec's launcher on first run", async () => {
		// `which tar` and `which zstd` both succeed.
		spawnState.syncHandlers.set("which", { status: 0, stdout: "/usr/bin/found\n", stderr: "" });
		// `tar` extract: synthesize the launcher being created by recording the
		// extraction in our fs state, then return success.
		spawnState.syncHandlers.set("tar", () => {
			fsState.existing.add(launcher);
			fsState.existing.add(libNative);
			return { status: 0, stdout: "", stderr: "" };
		});
		// ldd reports no missing libs once the bundle is "extracted".
		spawnState.syncHandlers.set("ldd", {
			status: 0,
			stdout: "\tlibwebkit2gtk-4.1.so.0 => /lib/...\n",
			stderr: "",
		});

		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(new Uint8Array([0, 1, 2, 3]), { status: 200 }),
		);

		try {
			await handleGui(undefined, args());
			expect(fetchSpy).toHaveBeenCalled();
			const url = fetchSpy.mock.calls[0][0];
			// Bundle URL is arch-aware: arm64 hosts resolve the arm64 bundle, all
			// others x64 — mirror linuxBundleArch() so this passes on any runner.
			const expectedArch = process.arch === "arm64" ? "arm64" : "x64";
			expect(String(url)).toContain(`stable-linux-${expectedArch}-dev-3.0.tar.zst`);
			const tarCall = spawnState.syncCalls.find((c) => c.cmd === "tar");
			expect(tarCall).toBeDefined();
			expect(tarCall?.args).toContain("-I");
			expect(tarCall?.args).toContain("zstd");
			// And the launcher was invoked after extract.
			const launcherCall = spawnState.calls.find((c) => c.cmd === launcher);
			expect(launcherCall).toBeDefined();
		} finally {
			fetchSpy.mockRestore();
		}
	});

	it("prints a hint when zstd is not on PATH", async () => {
		// `which tar` succeeds; `which zstd` fails.
		spawnState.syncHandlers.set("which", (args) => {
			if (args[0] === "tar") return { status: 0, stdout: "/usr/bin/tar\n", stderr: "" };
			return { status: 1, stdout: "", stderr: "" };
		});

		await expect(handleGui(undefined, args())).rejects.toThrow("__exit__");
		expect(combinedStderr()).toContain("zstd not found on PATH");
	});

	it("uses DEV3_GUI_BUNDLE_URL override when set", async () => {
		process.env.DEV3_GUI_BUNDLE_URL = "https://example.invalid/custom.tar.zst";
		spawnState.syncHandlers.set("which", { status: 0, stdout: "/usr/bin/found\n", stderr: "" });
		spawnState.syncHandlers.set("tar", () => {
			fsState.existing.add(launcher);
			fsState.existing.add(libNative);
			return { status: 0, stdout: "", stderr: "" };
		});
		spawnState.syncHandlers.set("ldd", { status: 0, stdout: "", stderr: "" });

		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(new Uint8Array([0]), { status: 200 }),
		);
		try {
			await handleGui(undefined, args());
			expect(fetchSpy.mock.calls[0][0]).toBe("https://example.invalid/custom.tar.zst");
		} finally {
			fetchSpy.mockRestore();
		}
	});
});
