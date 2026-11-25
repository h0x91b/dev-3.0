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
		it("returns no-worktree, no-makefile, or no-targets for a file with only variables", () => {
			const r = parseMakefile(null);
			expect(r.exists).toBe(false);
			expect(r.error).toBe("no-worktree");
			expect(r.targets).toEqual([]);
			expect(parseMakefile(tmp)).toMatchObject({ exists: false, error: "no-makefile" });
			writeFileSync(join(tmp, "Makefile"), "CC := gcc\nFLAGS = -O2\n");
			expect(parseMakefile(tmp)).toMatchObject({ exists: true, error: "no-targets", targets: [] });
		});

		it("parses targets, reports the file name, and prefers GNUmakefile over makefile over Makefile", () => {
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

			// GNUmakefile wins over makefile over Makefile.
			writeFileSync(join(tmp, "makefile"), "b:\n\techo b\n");
			writeFileSync(join(tmp, "GNUmakefile"), "c:\n\techo c\n");
			const preferred = parseMakefile(tmp);
			expect(preferred.path).toBe("GNUmakefile");
			expect(preferred.targets.map((t) => t.name)).toEqual(["c"]);
		});
	});

	describe("extractMakeTargets", () => {
		it("ignores assignments of every flavour, dot-special targets, pattern rules, directives and comments", () => {
			const mk = [
				"SIMPLE := value",
				"RECURSIVE = value",
				"COND ?= value",
				"APPEND += value",
				"IMMEDIATE ::= value",
				".PHONY: test build",
				".SUFFIXES:",
				"%.o: %.c",
				"\t$(CC) -c $<",
				"# a comment",
				"include common.mk",
				"ifeq ($(OS),Linux)",
				"real:",
				"\techo hi",
				"endif",
			].join("\n");
			expect(extractMakeTargets(mk).map((t) => t.name)).toEqual(["real"]);
		});

		it("keeps a target whose prereq contains a colon-ish value, and splits shared rule headers", () => {
			const mk = "deploy: build\n\t./deploy.sh\nbuild:\n\tmake bundle\n";
			expect(extractMakeTargets(mk).map((t) => t.name)).toEqual(["deploy", "build"]);
			// Multiple targets sharing one rule header are split.
			const targets = extractMakeTargets("lint format check:\n\techo running\n");
			expect(targets.map((t) => t.name)).toEqual(["lint", "format", "check"]);
			expect(targets.every((t) => t.command === "echo running")).toBe(true);
		});

		it("dedupes repeated target names (double-colon rules included), first occurrence wins", () => {
			const mk = "test:\n\tfirst\ntest:\n\tsecond\nall::\n\techo one\nall::\n\techo two\n";
			const targets = extractMakeTargets(mk);
			expect(targets.map((t) => t.name)).toEqual(["test", "all"]);
			expect(targets[0].command).toBe("first");
		});

		it("strips recipe modifiers from the preview", () => {
			const mk = "quiet:\n\t@echo hidden\nignore:\n\t-rm -f x\n";
			const targets = extractMakeTargets(mk);
			expect(targets.find((t) => t.name === "quiet")?.command).toBe("echo hidden");
			expect(targets.find((t) => t.name === "ignore")?.command).toBe("rm -f x");
			// A target with no recipe gets an empty preview.
			const docs = extractMakeTargets("docs: html pdf\n\nhtml:\n\tbuild-html\n");
			expect(docs.find((t) => t.name === "docs")?.command).toBe("");
			expect(docs.find((t) => t.name === "html")?.command).toBe("build-html");
		});
	});

	describe("resolveMakeCommand", () => {
		it("builds a make invocation", () => {
			expect(resolveMakeCommand("test")).toBe("make test");
			expect(resolveMakeCommand("doc-ingest")).toBe("make doc-ingest");
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
