import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { missingOmpDefaults, ompDefaultsArgs, ompDefaultsOverlayPath } from "../omp-launch-defaults";

let root: string;
let agentDir: string;
let worktree: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "omp-defaults-"));
	agentDir = join(root, "agent");
	worktree = join(root, "wt");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(worktree, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("omp launch defaults", () => {
	it("picks the Nerd Font symbols when nothing sets them", () => {
		expect(missingOmpDefaults(agentDir, worktree)).toEqual({ symbolPreset: "nerd" });
	});

	it("leaves the user's own choice in config.yml alone", () => {
		writeFileSync(join(agentDir, "config.yml"), "theme: dark\nsymbolPreset: ascii\n");
		expect(missingOmpDefaults(agentDir, worktree)).toEqual({});
	});

	it("leaves a project-level choice alone", () => {
		mkdirSync(join(worktree, ".omp"));
		writeFileSync(join(worktree, ".omp", "config.yaml"), "symbolPreset: unicode\n");
		expect(missingOmpDefaults(agentDir, worktree)).toEqual({});
	});

	it("does not mistake a nested key for the top-level setting", () => {
		writeFileSync(join(agentDir, "config.yml"), "theme:\n  symbolPreset: ascii\n");
		expect(missingOmpDefaults(agentDir, worktree)).toEqual({ symbolPreset: "nerd" });
	});

	it("passes the overlay as --config only when something is missing", () => {
		const dev3Home = join(root, "dev3");
		const args = ompDefaultsArgs({ agentDir, worktreePath: worktree, dev3Home });
		expect(args).toEqual(["--config", ompDefaultsOverlayPath(dev3Home)]);
		expect(readFileSync(ompDefaultsOverlayPath(dev3Home), "utf-8")).toBe("symbolPreset: nerd\n");

		writeFileSync(join(agentDir, "config.yml"), "symbolPreset: ascii\n");
		expect(ompDefaultsArgs({ agentDir, worktreePath: worktree, dev3Home })).toEqual([]);
	});
});
