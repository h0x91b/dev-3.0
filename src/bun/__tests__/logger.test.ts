import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Capture file writes without touching the real filesystem.
const appendFileSync = vi.fn();
const mkdirSync = vi.fn();
vi.mock("node:fs", () => ({
	appendFileSync: (...args: unknown[]) => appendFileSync(...args),
	mkdirSync: (...args: unknown[]) => mkdirSync(...args),
}));

import { createLogger, getMinLevel, resolveLogLevel, setMinLevel } from "../logger";

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
		expect(String(appendFileSync.mock.calls[0]?.[1])).toContain("[test] now visible");
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
		const wrote = appendFileSync.mock.calls.some((c) => String(c[1]).includes("[test] second-marker"));
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
