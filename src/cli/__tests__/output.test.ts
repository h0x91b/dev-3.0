import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { printTable, printDetail, exitError, exitAppNotRunning, exitInternalError, exitUsage } from "../output";
import {
	CLI_EXIT_CODE_APP_NOT_RUNNING,
	CLI_EXIT_CODE_COMMAND_FAILED,
	CLI_EXIT_CODE_INTERNAL_ERROR,
	CLI_EXIT_CODE_USAGE_ERROR,
} from "../../shared/cli-exit-codes";

let stdoutOutput: string;
let stderrOutput: string;
let stdoutSpy: ReturnType<typeof vi.spyOn>;
let stderrSpy: ReturnType<typeof vi.spyOn>;
let exitSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	stdoutOutput = "";
	stderrOutput = "";
	stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
		stdoutOutput += String(chunk);
		return true;
	});
	stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
		stderrOutput += String(chunk);
		return true;
	});
	exitSpy = vi.spyOn(process, "exit").mockImplementation((_code?: string | number | null) => {
		throw new Error(`EXIT_${_code ?? 0}`);
	}) as ReturnType<typeof vi.spyOn>;
});

afterEach(() => {
	stdoutSpy.mockRestore();
	stderrSpy.mockRestore();
	exitSpy.mockRestore();
});

describe("printTable", () => {
	it("prints headers and rows with auto-sized columns", () => {
		printTable(
			["ID", "NAME", "STATUS"],
			[
				["abc", "My Task", "todo"],
				["def12345", "Another", "in-progress"],
			],
		);
		const lines = stdoutOutput.split("\n").filter(Boolean);
		expect(lines).toHaveLength(3);
		// Header should contain all headers
		expect(lines[0]).toContain("ID");
		expect(lines[0]).toContain("NAME");
		expect(lines[0]).toContain("STATUS");
		// Columns should be aligned — "def12345" is wider than "ID", so ID column is at least 8 chars
		expect(lines[2]).toContain("def12345");
		expect(lines[2]).toContain("in-progress");
	});

	it("handles empty rows", () => {
		printTable(["ID", "NAME"], []);
		const lines = stdoutOutput.split("\n").filter(Boolean);
		expect(lines).toHaveLength(1); // Only header
		expect(lines[0]).toContain("ID");
	});

	it("handles single row", () => {
		printTable(["KEY"], [["value"]]);
		const lines = stdoutOutput.split("\n").filter(Boolean);
		expect(lines).toHaveLength(2);
		expect(lines[0]).toContain("KEY");
		expect(lines[1]).toContain("value");
	});

	it("pads shorter cells to align columns", () => {
		printTable(["A", "B"], [
			["short", "x"],
			["a", "longer-value"],
		]);
		const lines = stdoutOutput.split("\n").filter(Boolean);
		// All lines should have the same structure — second column starts at the same offset
		const col2Start0 = lines[0].indexOf("B");
		const col2Start1 = lines[1].indexOf("x");
		const col2Start2 = lines[2].indexOf("longer-value");
		expect(col2Start0).toBe(col2Start1);
		expect(col2Start0).toBe(col2Start2);
	});
});

describe("printDetail", () => {
	it("prints key-value pairs aligned", () => {
		printDetail([
			["Name:", "Test Project"],
			["ID:", "abc-123"],
		]);
		const lines = stdoutOutput.split("\n").filter(Boolean);
		expect(lines).toHaveLength(2);
		expect(lines[0]).toContain("Name:");
		expect(lines[0]).toContain("Test Project");
		expect(lines[1]).toContain("ID:");
		expect(lines[1]).toContain("abc-123");
	});

	it("aligns keys based on longest key", () => {
		printDetail([
			["Short:", "val1"],
			["Longer Key:", "val2"],
		]);
		const lines = stdoutOutput.split("\n").filter(Boolean);
		// "Short:" is padded to match "Longer Key:" length
		expect(lines[0].indexOf("val1")).toBe(lines[1].indexOf("val2"));
	});

	it("handles empty fields (separators)", () => {
		printDetail([
			["Key:", "val"],
			["", ""],
			["Other:", "val2"],
		]);
		const lines = stdoutOutput.split("\n");
		expect(lines.length).toBeGreaterThanOrEqual(3);
	});
});

describe("exitError", () => {
	it("writes error to stderr and exits with the default command-failed code", () => {
		expect(() => exitError("something broke")).toThrow(`EXIT_${CLI_EXIT_CODE_COMMAND_FAILED}`);
		expect(stderrOutput).toContain("error: something broke");
		expect(exitSpy).toHaveBeenCalledWith(CLI_EXIT_CODE_COMMAND_FAILED);
	});

	it("exits with custom code", () => {
		expect(() => exitError("bad input", undefined, 42)).toThrow("EXIT_42");
		expect(exitSpy).toHaveBeenCalledWith(42);
	});

	it("prints detail lines indented", () => {
		expect(() => exitError("main error", "line1\nline2")).toThrow();
		expect(stderrOutput).toContain("error: main error");
		expect(stderrOutput).toContain("  line1");
		expect(stderrOutput).toContain("  line2");
	});
});

describe("exitAppNotRunning", () => {
	it("exits with the app-not-running code and message", () => {
		expect(() => exitAppNotRunning()).toThrow(`EXIT_${CLI_EXIT_CODE_APP_NOT_RUNNING}`);
		expect(stderrOutput).toContain("app not running");
		expect(exitSpy).toHaveBeenCalledWith(CLI_EXIT_CODE_APP_NOT_RUNNING);
	});

	it("stays terse when no diagnostics are provided", () => {
		expect(() => exitAppNotRunning()).toThrow();
		expect(stderrOutput).not.toContain("DEV3_DEBUG");
		expect(stderrOutput).not.toContain("stage:");
	});

	it("appends stage and diagnostics when provided", () => {
		expect(() =>
			exitAppNotRunning({ stage: "discovery", diagnostics: "  HOME: /tmp\n  sockets: none present" }),
		).toThrow(`EXIT_${CLI_EXIT_CODE_APP_NOT_RUNNING}`);
		expect(stderrOutput).toContain("DEV3_DEBUG");
		expect(stderrOutput).toContain("stage: discovery");
		expect(stderrOutput).toContain("HOME: /tmp");
		expect(stderrOutput).toContain("sockets: none present");
	});

	it("on a connect-stage failure, blames the sandbox instead of 'start the app' (issue #726)", () => {
		expect(() =>
			exitAppNotRunning({ stage: "connect", socketPath: "/Users/me/.dev3.0/sockets/123.sock" }),
		).toThrow(`EXIT_${CLI_EXIT_CODE_APP_NOT_RUNNING}`);
		// Different headline than the truly-down case, and points at the sandbox.
		expect(stderrOutput).toContain("cannot reach the dev3.0 app");
		expect(stderrOutput).toContain("sandbox");
		expect(stderrOutput).toContain("allowUnixSockets");
		// Prints the socket path that was attempted.
		expect(stderrOutput).toContain("/Users/me/.dev3.0/sockets/123.sock");
		// Not the misleading "must be running / start the app" wording.
		expect(stderrOutput).not.toContain("Start the app and try again");
		expect(exitSpy).toHaveBeenCalledWith(CLI_EXIT_CODE_APP_NOT_RUNNING);
	});

	it("stays terse on a connect-stage failure without DEV3_DEBUG diagnostics", () => {
		expect(() => exitAppNotRunning({ stage: "connect", socketPath: "/x/y.sock" })).toThrow();
		expect(stderrOutput).not.toContain("DEV3_DEBUG");
		expect(stderrOutput).not.toContain("stage:");
	});
});

describe("exitUsage", () => {
	it("exits with the usage code", () => {
		expect(() => exitUsage("bad command")).toThrow(`EXIT_${CLI_EXIT_CODE_USAGE_ERROR}`);
		expect(stderrOutput).toContain("error: bad command");
		expect(exitSpy).toHaveBeenCalledWith(CLI_EXIT_CODE_USAGE_ERROR);
	});
});

describe("exitInternalError", () => {
	it("exits with the internal-error code", () => {
		expect(() => exitInternalError("boom")).toThrow(`EXIT_${CLI_EXIT_CODE_INTERNAL_ERROR}`);
		expect(stderrOutput).toContain("error: boom");
		expect(exitSpy).toHaveBeenCalledWith(CLI_EXIT_CODE_INTERNAL_ERROR);
	});
});
