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
