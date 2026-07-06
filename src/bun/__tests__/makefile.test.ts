import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseMakefile, extractMakeTargets, resolveMakeCommand } from "../makefile";

describe("makefile", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "dev3-makefile-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	describe("parseMakefile", () => {
		it("returns no-worktree when path is null", () => {
			const r = parseMakefile(null);
			expect(r.exists).toBe(false);
			expect(r.error).toBe("no-worktree");
			expect(r.targets).toEqual([]);
		});

		it("returns no-makefile when none present", () => {
			const r = parseMakefile(tmp);
			expect(r.exists).toBe(false);
			expect(r.error).toBe("no-makefile");
		});

		it("parses targets and reports the file name", () => {
			writeFileSync(
				join(tmp, "Makefile"),
				["test:", "\tpytest", "build:", "\tgo build ./..."].join("\n"),
			);
			const r = parseMakefile(tmp);
			expect(r.exists).toBe(true);
			// Case-insensitive filesystems (macOS/Windows) may report a differently
			// cased probe name; only the makefile identity matters here.
			expect(r.path?.toLowerCase()).toBe("makefile");
			expect(r.error).toBeNull();
			expect(r.targets.map((t) => t.name)).toEqual(["test", "build"]);
			expect(r.targets.find((t) => t.name === "build")?.command).toBe("go build ./...");
		});

		it("prefers GNUmakefile over makefile over Makefile", () => {
			writeFileSync(join(tmp, "Makefile"), "a:\n\techo a\n");
			writeFileSync(join(tmp, "makefile"), "b:\n\techo b\n");
			writeFileSync(join(tmp, "GNUmakefile"), "c:\n\techo c\n");
			const r = parseMakefile(tmp);
			expect(r.path).toBe("GNUmakefile");
			expect(r.targets.map((t) => t.name)).toEqual(["c"]);
		});

		it("returns no-targets when file only has variables", () => {
			writeFileSync(join(tmp, "Makefile"), "CC := gcc\nFLAGS = -O2\n");
			const r = parseMakefile(tmp);
			expect(r.exists).toBe(true);
			expect(r.error).toBe("no-targets");
			expect(r.targets).toEqual([]);
		});
	});

	describe("extractMakeTargets", () => {
		it("ignores every assignment operator flavour", () => {
			const mk = [
				"SIMPLE := value",
				"RECURSIVE = value",
				"COND ?= value",
				"APPEND += value",
				"IMMEDIATE ::= value",
				"real:",
				"\techo hi",
			].join("\n");
			expect(extractMakeTargets(mk).map((t) => t.name)).toEqual(["real"]);
		});

		it("keeps a target whose prereq contains a colon-ish value", () => {
			const mk = "deploy: build\n\t./deploy.sh\nbuild:\n\tmake bundle\n";
			expect(extractMakeTargets(mk).map((t) => t.name)).toEqual(["deploy", "build"]);
		});

		it("skips dot-special targets and pattern rules", () => {
			const mk = [
				".PHONY: test build",
				".SUFFIXES:",
				"%.o: %.c",
				"\t$(CC) -c $<",
				"test:",
				"\tpytest",
			].join("\n");
			expect(extractMakeTargets(mk).map((t) => t.name)).toEqual(["test"]);
		});

		it("splits multiple targets sharing one rule header", () => {
			const mk = "lint format check:\n\techo running\n";
			const targets = extractMakeTargets(mk);
			expect(targets.map((t) => t.name)).toEqual(["lint", "format", "check"]);
			expect(targets.every((t) => t.command === "echo running")).toBe(true);
		});

		it("dedupes repeated target names, first occurrence wins", () => {
			const mk = "test:\n\tfirst\ntest:\n\tsecond\n";
			const targets = extractMakeTargets(mk);
			expect(targets.map((t) => t.name)).toEqual(["test"]);
			expect(targets[0].command).toBe("first");
		});

		it("treats double-colon rules as targets", () => {
			const mk = "all::\n\techo one\nall::\n\techo two\n";
			expect(extractMakeTargets(mk).map((t) => t.name)).toEqual(["all"]);
		});

		it("strips recipe modifiers from the preview", () => {
			const mk = "quiet:\n\t@echo hidden\nignore:\n\t-rm -f x\n";
			const targets = extractMakeTargets(mk);
			expect(targets.find((t) => t.name === "quiet")?.command).toBe("echo hidden");
			expect(targets.find((t) => t.name === "ignore")?.command).toBe("rm -f x");
		});

		it("ignores directives and comments", () => {
			const mk = [
				"# a comment",
				"include common.mk",
				"ifeq ($(OS),Linux)",
				"linux:",
				"\techo linux",
				"endif",
			].join("\n");
			expect(extractMakeTargets(mk).map((t) => t.name)).toEqual(["linux"]);
		});

		it("gives an empty preview when a target has no recipe", () => {
			const mk = "docs: html pdf\n\nhtml:\n\tbuild-html\n";
			const targets = extractMakeTargets(mk);
			expect(targets.find((t) => t.name === "docs")?.command).toBe("");
			expect(targets.find((t) => t.name === "html")?.command).toBe("build-html");
		});
	});

	describe("resolveMakeCommand", () => {
		it("builds a make invocation", () => {
			expect(resolveMakeCommand("test")).toBe("make test");
			expect(resolveMakeCommand("doc-ingest")).toBe("make doc-ingest");
		});
		it("allows colon, dot and slash in target names", () => {
			expect(resolveMakeCommand("build.prod")).toBe("make build.prod");
			expect(resolveMakeCommand("ci/test")).toBe("make ci/test");
		});
		it("rejects shell-meta in target names", () => {
			expect(() => resolveMakeCommand("test; rm -rf /")).toThrow(/invalid/);
			expect(() => resolveMakeCommand("test`whoami`")).toThrow(/invalid/);
			expect(() => resolveMakeCommand("test$(echo)")).toThrow(/invalid/);
		});
	});
});
