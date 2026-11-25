import { describe, it, expect } from "vitest";
import {
	hookCliDialect,
	POSIX_DEV3_CLI,
	hookCliCommandPath,
	resolveDev3CliPath,
	windowsDev3CliCandidates,
} from "../../shared/dev3-cli-path";

const EXEC_DIR = "C:\\Program Files\\dev3\\bin";
const HOME = "C:\\Users\\dev";

describe("windowsDev3CliCandidates", () => {
	it("prefers the CLI bundled next to the running binary, then Resources/app, then the user dir, dropping unknown anchors", () => {
		expect(windowsDev3CliCandidates(EXEC_DIR, HOME)).toEqual([
			"C:\\Program Files\\dev3\\bin\\cli\\dev3.exe",
			"C:\\Program Files\\dev3\\Resources\\app\\cli\\dev3.exe",
			"C:\\Users\\dev\\.dev3.0\\bin\\dev3.exe",
		]);
		expect(windowsDev3CliCandidates(undefined, HOME)).toEqual(["C:\\Users\\dev\\.dev3.0\\bin\\dev3.exe"]);
		expect(windowsDev3CliCandidates(EXEC_DIR, undefined)).toHaveLength(2);
		expect(windowsDev3CliCandidates(undefined, undefined)).toEqual([]);
	});
});

describe("resolveDev3CliPath", () => {
	it("returns the frozen POSIX string on darwin and linux, without touching the filesystem", () => {
		const exists = () => {
			throw new Error("must not probe the filesystem on POSIX");
		};
		expect(resolveDev3CliPath({ platform: "darwin", exists })).toBe(POSIX_DEV3_CLI);
		expect(resolveDev3CliPath({ platform: "linux", exists })).toBe(POSIX_DEV3_CLI);
	});

	it("picks the first Windows candidate that exists, else the per-user dir, never with a tilde", () => {
		const win = { platform: "win32" as const, execDir: EXEC_DIR, homeDir: HOME };
		expect(resolveDev3CliPath({
			...win,
			exists: (candidate) => candidate === "C:\\Program Files\\dev3\\Resources\\app\\cli\\dev3.exe",
		})).toBe("C:\\Program Files\\dev3\\Resources\\app\\cli\\dev3.exe");
		const fallback = resolveDev3CliPath({ ...win, exists: () => false });
		expect(fallback).toBe("C:\\Users\\dev\\.dev3.0\\bin\\dev3.exe");
		expect(fallback).not.toContain("~");
	});
});

describe("hookCliCommandPath", () => {
	it("turns separators into forward slashes and quotes unconditionally, so bash keeps one argument", () => {
		expect(hookCliCommandPath("C:\\dev3\\dev3.exe")).toBe('"C:/dev3/dev3.exe"');
		expect(hookCliCommandPath("C:\\Program Files\\dev3.exe")).toBe('"C:/Program Files/dev3.exe"');
	});
});

describe("hookCliDialect", () => {
	it("keeps POSIX shell semantics off Windows", () => {
		expect(hookCliDialect({ platform: "darwin" })).toEqual({ cli: POSIX_DEV3_CLI, posixShell: true });
		expect(hookCliDialect({ platform: "linux" })).toEqual({ cli: POSIX_DEV3_CLI, posixShell: true });
	});

	it("gives Windows an absolute, quoted, forward-slashed CLI and no POSIX shell", () => {
		expect(hookCliDialect({ platform: "win32", execDir: EXEC_DIR, homeDir: HOME, exists: () => false })).toEqual({
			cli: '"C:/Users/dev/.dev3.0/bin/dev3.exe"',
			posixShell: false,
		});
		expect(hookCliDialect({ platform: "win32", execDir: EXEC_DIR, homeDir: "C:\\Users\\John Doe", exists: () => false }).cli)
			.toBe('"C:/Users/John Doe/.dev3.0/bin/dev3.exe"');
	});

	it("never emits a bare backslash — Git Bash would strip it (the hook repro)", () => {
		const cli = hookCliDialect({ platform: "win32", execDir: "C:\\dev3", homeDir: "C:\\home", exists: () => false }).cli;
		expect(cli).toBe('"C:/home/.dev3.0/bin/dev3.exe"');
		expect(cli).not.toContain("\\");
	});
});
