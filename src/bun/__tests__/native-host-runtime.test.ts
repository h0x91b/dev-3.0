/**
 * Which host runtime THIS build launches a native terminal from (seq 1292), and
 * the env contract the detached host is spawned with. Hermetic on purpose:
 * packaged-image discovery is mocked to "absent" so the resolution order is
 * driven entirely by the env override and the source-checkout probe.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("../logger", () => ({
	createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock("node:child_process", () => ({
	spawn: vi.fn(() => ({ pid: 4242, on: vi.fn(), unref: vi.fn() })),
}));

vi.mock("../native-terminal-registry/host-images/packaged-image", () => ({
	PACKAGED_HOST_IMAGE_PARENT: "native-host-image",
	PACKAGED_HOST_ENTRYPOINT: "dev3-terminal-host.js",
	discoverPackagedImage: vi.fn(() => ({ status: "absent", reason: "no native-host-image/ in this test package" })),
	stagePackagedImage: vi.fn(() => ({ status: "failed", tag: null, reason: "not reached" })),
}));

// The source-checkout probe must be switchable: this repo genuinely has the
// registry CLI on disk, and one case needs a build that does not.
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return { ...actual, default: actual, existsSync: vi.fn(actual.existsSync), realpathSync: vi.fn(actual.realpathSync) };
});

import { existsSync, realpathSync } from "node:fs";
import { spawn } from "node:child_process";
const realFs = await vi.importActual<typeof import("node:fs")>("node:fs");
import {
	NATIVE_HOST_ENTRYPOINT_ENV,
	NATIVE_HOST_RUNTIME_ENV,
	NativeHostRuntimeError,
	nativeHostLauncher,
	packagedHostImageRoots,
	PACKAGED_HOST_SESSION_VERB,
	resolveNativeHostRuntime,
} from "../native-host-runtime";
import { discoverPackagedImage } from "../native-terminal-registry/host-images/packaged-image";
import { nativeHostPackageLayout } from "../native-terminal-registry/host-images/package-layout";
import { encodeShellLaunchSpec, NATIVE_SESSION_LAUNCH_ENV } from "../native-terminal-registry/shell-launch";

const TEST_ROOT = join(process.env.DEV3_TEST_ROOT ?? "/tmp", "native-host-runtime");
const ENTRYPOINT = join(TEST_ROOT, "dev3-terminal-host.js");

const SESSION_ID = "dev3-task-aabbccdd-1111-2222-3333-444444444444";

function launchSpec() {
	return { executable: "/bin/zsh", argv: ["/tmp/dev3/run.sh"], cwd: "/tmp/wt", env: { DEV3_TASK_ID: "aabbccdd" } };
}

/**
 * `nativeHostLauncher` builds the child env by spreading `process.env`, so any
 * DEV3_NATIVE_SESSION_* variable already in the ambient environment lands in the
 * assertion. A shell running inside a dev3 NATIVE pane (not tmux) has exactly
 * those exported by its host, which made this suite fail for an agent working in
 * one and pass everywhere else — read as pre-existing repo breakage twice before
 * the cause was found. The environment is the test's to control, not the run's.
 */
function clearAmbientNativeSessionEnv(): void {
	for (const key of Object.keys(process.env)) {
		if (key.indexOf("DEV3_NATIVE_SESSION") === 0) delete process.env[key];
	}
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(existsSync).mockImplementation(realFs.existsSync);
	vi.mocked(realpathSync).mockImplementation(realFs.realpathSync as never);
	mkdirSync(TEST_ROOT, { recursive: true });
	writeFileSync(ENTRYPOINT, "// built host bundle\n");
	clearAmbientNativeSessionEnv();
	delete process.env[NATIVE_HOST_ENTRYPOINT_ENV];
	delete process.env[NATIVE_HOST_RUNTIME_ENV];
});

afterEach(() => {
	delete process.env[NATIVE_HOST_ENTRYPOINT_ENV];
	delete process.env[NATIVE_HOST_RUNTIME_ENV];
	// clearAllMocks keeps implementations, so restore the hermetic "no image" one.
	vi.mocked(discoverPackagedImage).mockImplementation(
		() => ({ status: "absent", reason: "no native-host-image/ in this test package" }) as never,
	);
});

describe("development entrypoint override", () => {
	it("resolves the built host bundle with the packaged session verb", () => {
		process.env[NATIVE_HOST_ENTRYPOINT_ENV] = ENTRYPOINT;

		const runtime = resolveNativeHostRuntime();

		expect(runtime.kind).toBe("development-entrypoint");
		expect(runtime.entrypointPath).toBe(ENTRYPOINT);
		expect(runtime.sessionVerb).toBe(PACKAGED_HOST_SESSION_VERB);
		expect(runtime.sessionVerb).toBe("session-host");
	});

	it("defaults the runtime to this process's executable", () => {
		process.env[NATIVE_HOST_ENTRYPOINT_ENV] = ENTRYPOINT;

		expect(resolveNativeHostRuntime().runtimePath).toBe(process.execPath);
	});

	it("lets the runtime be overridden explicitly", () => {
		process.env[NATIVE_HOST_ENTRYPOINT_ENV] = ENTRYPOINT;
		process.env[NATIVE_HOST_RUNTIME_ENV] = "/opt/homebrew/bin/bun";

		expect(resolveNativeHostRuntime().runtimePath).toBe("/opt/homebrew/bin/bun");
	});

	it("fails loudly when the override points at a missing file", () => {
		process.env[NATIVE_HOST_ENTRYPOINT_ENV] = join(TEST_ROOT, "not-built.js");

		expect(() => resolveNativeHostRuntime()).toThrow(NativeHostRuntimeError);
		expect(() => resolveNativeHostRuntime()).toThrow(/points at a missing file/);
	});
});

describe("a build with no launchable host", () => {
	function noRuntimeError(): NativeHostRuntimeError {
		vi.mocked(existsSync).mockImplementation(() => false); // no packaged image, no registry CLI source
		try {
			resolveNativeHostRuntime();
		} catch (err) {
			return err as NativeHostRuntimeError;
		}
		throw new Error("resolveNativeHostRuntime resolved a runtime it should not have found");
	}

	it("names the build step, the reinstall, and the tmux escape hatch", () => {
		const error = noRuntimeError();

		expect(error).toBeInstanceOf(NativeHostRuntimeError);
		expect(error.message).toContain("bun run build:native");
		expect(error.message).toMatch(/reinstall/i);
		expect(error.message).toContain("dev3 task terminal-backend --to tmux");
	});

	it("mentions tmux only as that escape hatch, never as something it started", () => {
		const tmuxLines = noRuntimeError().message
			.split("\n")
			.filter((line) => /tmux/i.test(line));

		expect(tmuxLines).toEqual([
			"This dev3 build cannot launch a native terminal host, and it will not silently start tmux instead.",
			"Or set this task's terminal backend back to tmux: `dev3 task terminal-backend --to tmux`.",
		]);
	});
});

describe("packaged image lookup", () => {
	it("looks beside the runtime first, then one level up", () => {
		const roots = packagedHostImageRoots();
		expect(roots.length).toBe(2);
		expect(join(roots[0], "..")).toBe(roots[1]);
	});

	it("covers where every platform's packaging hook writes the image", () => {
		const roots = packagedHostImageRoots();

		// macOS assembles under <bundle>.app/Contents, one level above MacOS/bun.
		expect(nativeHostPackageLayout("darwin", join(roots[0], "bun")).hostImagePackageRoot).toBe(roots[1]);
		// Linux and Windows assemble at the bundle root, one level above bin/bun.
		expect(nativeHostPackageLayout("linux", join(roots[0], "bun")).hostImagePackageRoot).toBe(roots[1]);
	});

	it("reaches the image from the bundled dev3 CLI that `dev3 remote` runs", () => {
		// Seq 1352: headless mode's execPath is <bundle>.app/Contents/Resources/app/cli/dev3,
		// and neither directory around it holds the image.
		const cliPath = "/Apps/dev-3.0.app/Contents/Resources/app/cli/dev3";
		vi.mocked(realpathSync).mockImplementation(((path: string) => (path === process.execPath ? cliPath : path)) as never);

		const roots = packagedHostImageRoots();

		expect(roots).toEqual([
			"/Apps/dev-3.0.app/Contents/Resources/app/cli",
			"/Apps/dev-3.0.app/Contents/Resources/app",
			"/Apps/dev-3.0.app/Contents",
		]);
		expect(roots[roots.length - 1]).toBe(nativeHostPackageLayout("darwin", "/Apps/dev-3.0.app/Contents/MacOS/bun").hostImagePackageRoot);
	});

	it("adds nothing extra for a desktop runtime that is not the bundled CLI", () => {
		expect(packagedHostImageRoots()).toHaveLength(2);
	});

	it("finds an image the Windows package wrote above the runtime's bin/ directory", () => {
		const roots = packagedHostImageRoots();
		vi.mocked(discoverPackagedImage).mockImplementation((root: string) =>
			root === roots[1]
				? ({ status: "ok", imageDir: join(root, "native-host-image", "tag"), tag: "tag", manifest: {} } as never)
				: ({ status: "absent", reason: "no native-host-image/ here" } as never),
		);
		vi.mocked(existsSync).mockImplementation(() => false); // no registry CLI source either

		// The near root misses, the parent hits — resolution must not stop at the miss.
		expect(() => resolveNativeHostRuntime()).toThrow(/Staging the packaged host image/);
	});
});

describe("nativeHostLauncher", () => {
	beforeEach(() => {
		process.env[NATIVE_HOST_ENTRYPOINT_ENV] = ENTRYPOINT;
	});

	it("spawns <runtime> <entrypoint> <verb> <sessionId> detached onto the log fd", () => {
		const runtime = resolveNativeHostRuntime();

		const launch = nativeHostLauncher(runtime)(SESSION_ID, { launch: launchSpec() }, 7);

		expect(launch.childPid).toBe(4242);
		expect(spawn).toHaveBeenCalledTimes(1);
		const [runtimePath, argv, options] = vi.mocked(spawn).mock.calls[0];
		expect(runtimePath).toBe(process.execPath);
		expect(argv).toEqual([ENTRYPOINT, "session-host", SESSION_ID]);
		expect(options).toMatchObject({ stdio: ["ignore", 7, 7], detached: true });
	});

	it("hands the session id, launch spec, and geometry over through the environment", () => {
		const spec = launchSpec();

		nativeHostLauncher(resolveNativeHostRuntime())(
			SESSION_ID,
			{ launch: spec, cols: 120, rows: 40, liveParser: true },
			7,
		);

		const env = vi.mocked(spawn).mock.calls[0][2]?.env ?? {};
		expect(env.DEV3_NATIVE_SESSION_ID).toBe(SESSION_ID);
		expect(env[NATIVE_SESSION_LAUNCH_ENV]).toBe(encodeShellLaunchSpec(spec));
		expect(env.DEV3_NATIVE_SESSION_COLS).toBe("120");
		expect(env.DEV3_NATIVE_SESSION_ROWS).toBe("40");
		expect(env.DEV3_NATIVE_SESSION_LIVE_PARSER).toBe("1");
	});

	it("omits the opt-in proof flags when they were not requested", () => {
		nativeHostLauncher(resolveNativeHostRuntime())(SESSION_ID, { launch: launchSpec() }, 7);

		const env = vi.mocked(spawn).mock.calls[0][2]?.env ?? {};
		expect(env).not.toHaveProperty("DEV3_NATIVE_SESSION_LIVE_PARSER");
		expect(env).not.toHaveProperty("DEV3_NATIVE_SESSION_STATE_TAP");
		expect(env).not.toHaveProperty("DEV3_NATIVE_SESSION_COLS");
	});
});
