/**
 * tmux splits a config line into words. A value spliced in raw therefore breaks
 * the line as soon as it contains a space ("too many arguments", verified on
 * tmux 3.6a) and becomes a second COMMAND as soon as it contains a newline.
 * `$ENV` is the user's own variable, so neither is hypothetical.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildThemeConfig } from "../tmux/config";

const originalEnv = process.env.ENV;

function userEnvLine(): string | undefined {
	return buildThemeConfig("mocha")
		.split("\n")
		.find((line) => line.startsWith("set-environment -g DEV3_USER_ENV"));
}

describe("tmux config — the user's own $ENV", () => {
	beforeEach(() => {
		delete process.env.ENV;
	});

	afterEach(() => {
		if (originalEnv === undefined) delete process.env.ENV;
		else process.env.ENV = originalEnv;
	});

	it("quotes a path so a space cannot break the line", () => {
		process.env.ENV = "/Users/john doe/.shrc";
		expect(userEnvLine()).toBe("set-environment -g DEV3_USER_ENV '/Users/john doe/.shrc'");
	});

	it("drops a value that cannot be quoted at all rather than emitting a broken line", () => {
		// tmux single quotes are literal and have no escape, so neither of these
		// can be represented — and a newline would run as a tmux command.
		process.env.ENV = "/tmp/x\nkill-server";
		expect(userEnvLine()).toBeUndefined();
		process.env.ENV = "/tmp/it's.shrc";
		expect(userEnvLine()).toBeUndefined();
	});

	it("forwards nothing when the user has no $ENV", () => {
		expect(userEnvLine()).toBeUndefined();
	});

	it("quotes the shell baked into default-shell", () => {
		const line = buildThemeConfig("mocha")
			.split("\n")
			.find((entry) => entry.startsWith("set -g default-shell"));
		expect(line).toMatch(/^set -g default-shell '\/.+'$/);
	});
});
