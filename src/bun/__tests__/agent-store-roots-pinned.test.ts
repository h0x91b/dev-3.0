import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claudeConfigDirs } from "../agent-store-roots";

describe("claudeConfigDirs with pinned dirs", () => {
	let home = "";
	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "dev3-store-roots-"));
		mkdirSync(join(home, ".claude"));
	});
	afterEach(() => rmSync(home, { recursive: true, force: true }));

	it("adds each existing pinned dir once, after the home store", () => {
		const project = join(home, "proj", ".claude");
		mkdirSync(project, { recursive: true });
		const alias = join(home, "alias");
		symlinkSync(project, alias, "dir");

		expect(claudeConfigDirs(home, [project, join(home, "gone"), alias, join(home, ".claude")])).toEqual([
			join(home, ".claude"),
			project,
		]);
	});
});
