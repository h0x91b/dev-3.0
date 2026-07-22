import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Capture file writes without touching the real filesystem.
const appendFileSync = vi.fn();
const mkdirSync = vi.fn();
const readdirSync = vi.fn();
const unlinkSync = vi.fn();
vi.mock("node:fs", () => ({
	appendFileSync: (...args: unknown[]) => appendFileSync(...args),
	mkdirSync: (...args: unknown[]) => mkdirSync(...args),
	readdirSync: (...args: unknown[]) => readdirSync(...args),
	unlinkSync: (...args: unknown[]) => unlinkSync(...args),
}));

import {
	createLogger,
	getLogPath,
	getMinLevel,
	pruneLogFiles,
	resolveLogDir,
	resolveLogLevel,
	setMinLevel,
} from "../logger";

describe("resolveLogDir", () => {
	it("honors an explicit DEV3_LOG_DIR override above everything else", () => {
		expect(resolveLogDir({ DEV3_LOG_DIR: "/custom/logs", VITEST: "true" })).toBe("/custom/logs");
		expect(resolveLogDir({ DEV3_LOG_DIR: "  /trimmed  " })).toBe("/trimmed");
	});

	it("redirects to an isolated tmp dir under a test runner (never the real ~/.dev3.0/logs)", () => {
		const underVitest = resolveLogDir({ VITEST: "true" });
		const underNodeEnv = resolveLogDir({ NODE_ENV: "test" });
		expect(underVitest).toContain("dev3-test-logs");
		expect(underNodeEnv).toContain("dev3-test-logs");
		expect(underVitest).not.toContain("/.dev3.0/logs");
	});

	it("uses the real ${DEV3_HOME}/logs for the app / CLI (no test signal, no override)", () => {
		expect(resolveLogDir({})).toMatch(/\.dev3\.0\/logs$/);
	});

	it("ignores a blank DEV3_LOG_DIR and falls through to the next rule", () => {
		expect(resolveLogDir({ DEV3_LOG_DIR: "   ", VITEST: "true" })).toContain("dev3-test-logs");
	});
});

describe("test-run log isolation (regression: fake ERROR/WARN pollution)", () => {
	// The whole suite runs under vitest (VITEST=true), so the live logger sink
	// must already point away from the real user log. If this ever fails, unit
	// tests are appending synthetic lines to ~/.dev3.0/logs again.
	it("never resolves the live log directory inside the real ~/.dev3.0/logs", () => {
		expect(getLogPath()).not.toContain("/.dev3.0/logs");
	});
});

describe("resolveLogLevel", () => {
	it("honors an explicit DEV3_LOG_LEVEL override (case-insensitive)", () => {
		expect(resolveLogLevel({ DEV3_LOG_LEVEL: "debug", DEV3_CHANNEL: "prod" })).toBe("debug");
		expect(resolveLogLevel({ DEV3_LOG_LEVEL: "WARN" })).toBe("warn");
		expect(resolveLogLevel({ DEV3_LOG_LEVEL: "error", DEV3_CHANNEL: "dev" })).toBe("error");
	});

	it("ignores an invalid DEV3_LOG_LEVEL and falls back to channel default", () => {
		expect(resolveLogLevel({ DEV3_LOG_LEVEL: "verbose", DEV3_CHANNEL: "prod" })).toBe("info");
		expect(resolveLogLevel({ DEV3_LOG_LEVEL: "", DEV3_CHANNEL: "dev" })).toBe("debug");
	});

	it("keeps full debug logs on the dev channel", () => {
		expect(resolveLogLevel({ DEV3_CHANNEL: "dev" })).toBe("debug");
	});

	it("defaults to info for prod / staging / canary / unset channel", () => {
		expect(resolveLogLevel({ DEV3_CHANNEL: "prod" })).toBe("info");
		expect(resolveLogLevel({ DEV3_CHANNEL: "staging" })).toBe("info");
		expect(resolveLogLevel({ DEV3_CHANNEL: "canary" })).toBe("info");
		expect(resolveLogLevel({})).toBe("info");
	});
});

describe("level gating", () => {
	const consoleSpies = [
		vi.spyOn(console, "log").mockImplementation(() => {}),
		vi.spyOn(console, "warn").mockImplementation(() => {}),
		vi.spyOn(console, "error").mockImplementation(() => {}),
	];

	beforeEach(() => {
		appendFileSync.mockClear();
	});

	afterEach(() => {
		for (const s of consoleSpies) s.mockClear();
	});

	it("suppresses debug lines at info level (the prod default)", () => {
		setMinLevel("info");
		expect(getMinLevel()).toBe("info");
		const log = createLogger("test");

		log.debug("should be dropped");
		expect(appendFileSync).not.toHaveBeenCalled();

		log.info("should be written");
		log.warn("and this");
		log.error("and this too");
		expect(appendFileSync).toHaveBeenCalledTimes(3);
	});

	it("writes debug lines once the level is debug (dev)", () => {
		setMinLevel("debug");
		const log = createLogger("test");

		log.debug("now visible");
		expect(appendFileSync).toHaveBeenCalledTimes(1);
		expect(String(appendFileSync.mock.calls[0]?.[1])).toContain(`[${process.pid}:test] now visible`);
	});

	it("only writes errors at error level", () => {
		setMinLevel("error");
		const log = createLogger("test");

		log.debug("no");
		log.info("no");
		log.warn("no");
		expect(appendFileSync).not.toHaveBeenCalled();

		log.error("yes");
		expect(appendFileSync).toHaveBeenCalledTimes(1);
	});
});

describe("diagnostic payload safety", () => {
	beforeEach(() => {
		appendFileSync.mockClear();
		readdirSync.mockReset();
		readdirSync.mockReturnValue([]);
		unlinkSync.mockReset();
		setMinLevel("debug");
	});

	it("removes prompt and command payloads while keeping structural fields", () => {
		const promptCanary = "PROMPT_CANARY_private-url-and-injected-instructions";
		const commandCanary = "COMMAND_CANARY_secret-argument";
		const urlCanary = "URL_CANARY_private-query";
		const credentialCanary = "CREDENTIAL_CANARY_private-token";
		const log = createLogger("privacy-test");

		log.info("Agent launch", {
			taskId: "task-structural",
			event: "launchTaskPty",
			durationMs: 42,
			exitCode: 7,
			params: { description: promptCanary },
			tmuxCommand: `claude --prompt ${commandCanary}`,
			installCmd: `brew install ${commandCanary}`,
			command: `claude --prompt ${commandCanary}`,
			url: `https://example.test/?token=${urlCanary}`,
			extraEnv: { API_TOKEN: credentialCanary },
			error: "ENOENT",
			stderr: "useful local failure details",
		});

		const output = appendFileSync.mock.calls.map((call) => String(call[1])).join("\n");
		expect(output).not.toContain(promptCanary);
		expect(output).not.toContain(commandCanary);
		expect(output).not.toContain(urlCanary);
		expect(output).not.toContain(credentialCanary);
		expect(output).toContain("task-structural");
		expect(output).toContain("launchTaskPty");
		expect(output).toContain('"durationMs":42');
		expect(output).toContain('"exitCode":7');
		expect(output).toContain('"executable":"claude"');
		expect(output).toContain('"argumentCount":2');
		expect(output).toContain('"error":"ENOENT"');
		expect(output).toContain('"stderr":"useful local failure details"');
	});
});

describe("diagnostic log retention", () => {
	const root = "/tmp/dev3-diagnostic-logs";
	const dirent = (name: string, directory: boolean) => ({
		name,
		isDirectory: () => directory,
		isFile: () => !directory,
	});

	beforeEach(() => {
		readdirSync.mockReset();
		unlinkSync.mockReset();
	});

	it("removes daily files older than the documented retention window", () => {
		const entries: Record<string, unknown[]> = {
			[root]: [dirent("2026", true)],
			[`${root}/2026`]: [dirent("07", true)],
			[`${root}/2026/07`]: [
				dirent("2026-07-08.log", false),
				dirent("2026-07-09.log", false),
				dirent("2026-07-22.log", false),
			],
		};
		readdirSync.mockImplementation((path: string) => entries[path] ?? []);

		expect(pruneLogFiles(new Date(2026, 6, 22, 12), root)).toBe(1);
		expect(unlinkSync).toHaveBeenCalledWith(`${root}/2026/07/2026-07-08.log`);
		expect(unlinkSync).not.toHaveBeenCalledWith(`${root}/2026/07/2026-07-09.log`);
	});

	it("does not make logging fail when the retention scan is unavailable", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(2026, 6, 23));
		readdirSync.mockImplementation(() => {
			throw new Error("diagnostic directory unavailable");
		});
		appendFileSync.mockImplementation(() => {});
		const log = createLogger("retention-test");

		expect(() => pruneLogFiles(new Date(2026, 6, 22), root)).not.toThrow();
		expect(() => log.info("still running", { taskId: "task-safe" })).not.toThrow();
		expect(appendFileSync).toHaveBeenCalled();
		expect(readdirSync).toHaveBeenCalled();
	});

	afterEach(() => {
		vi.useRealTimers();
	});
});

describe("self-healing when the log directory disappears", () => {
	// Regression: the logger caches which directories it has created in a
	// module-level `ensuredDirs` set. When that directory is later removed out
	// from under it — a tmp dir wiped between tests (the settings test does this
	// in `beforeEach`), or a user clearing ~/.dev3.0/logs at runtime — the stale
	// cache made `ensureDir` skip the mkdir, so the synchronous append hit a
	// missing directory and spammed "[logger] Failed to write log file" on every
	// subsequent line. The fix recreates the directory and retries once.
	beforeEach(() => {
		appendFileSync.mockReset();
		mkdirSync.mockReset();
		appendFileSync.mockImplementation(() => {});
		mkdirSync.mockImplementation(() => {});
		setMinLevel("debug");
	});

	it("invalidates the cached dir, recreates it, and retries once on a write error", () => {
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const log = createLogger("test");

		// Warm the dir cache with a first successful write.
		log.info("first");
		const mkdirCallsAfterWarm = mkdirSync.mock.calls.length;

		// The directory is now gone: the next append fails with ENOENT because the
		// stale cache skipped the mkdir. The retry must recreate it and succeed.
		appendFileSync.mockImplementationOnce(() => {
			const err = new Error("ENOENT") as NodeJS.ErrnoException;
			err.code = "ENOENT";
			throw err;
		});

		log.info("second-marker");

		// Retry recreated the directory (at least one extra mkdir beyond warm-up).
		expect(mkdirSync.mock.calls.length).toBeGreaterThan(mkdirCallsAfterWarm);
		// The line was ultimately written (initial failure + successful retry).
		const wrote = appendFileSync.mock.calls.some((c) => String(c[1]).includes(`[${process.pid}:test] second-marker`));
		expect(wrote).toBe(true);
		// No "[logger] Failed to write log file" noise.
		expect(errSpy).not.toHaveBeenCalled();

		errSpy.mockRestore();
	});

	it("logs a single console.error only when the retry also fails", () => {
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const log = createLogger("test");
		log.info("warm");

		// Both the initial write and the retry fail (e.g. permission denied) — the
		// logger gives up after one retry and surfaces exactly one error.
		appendFileSync.mockImplementation(() => {
			throw new Error("EACCES: permission denied");
		});

		log.info("doomed");

		expect(errSpy).toHaveBeenCalledTimes(1);
		expect(String(errSpy.mock.calls[0]?.[0])).toContain("Failed to write log file");

		errSpy.mockRestore();
	});
});
