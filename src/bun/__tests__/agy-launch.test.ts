import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CodingAgent } from "../../shared/types";
import { resolveAgentCommand, type TemplateContext } from "../agents";
import { resolveAccountHome } from "../../shared/user-home";

// agy trusts a workspace only by its resolved path: `/tmp/x` is a miss, `/private/tmp/x` a hit.

const AGY: CodingAgent = { id: "a", name: "A", baseCommand: "agy", configurations: [] };
let root: string;
let real: string;
let link: string;

const ctx = (worktreePath: string): TemplateContext => ({
	taskTitle: "t",
	taskDescription: "Fix it",
	projectName: "p",
	projectPath: "/p",
	worktreePath,
});

/** The trusted workspaces inside a launch command's `--settings` argument. */
function trusted(command: string): string[] {
	const raw = command.match(/--settings '(.*?)' -i/)![1]!.replaceAll("'\\''", "'");
	return JSON.parse(raw).trustedWorkspaces;
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "dev3-agy-launch-"));
	real = join(root, "real");
	link = join(root, "link");
	mkdirSync(real);
	symlinkSync(real, link);
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("resolveAgentCommand for agy", () => {
	it("trusts the worktree's realpath, not the symlinked path the task was given", async () => {
		const command = await resolveAgentCommand(AGY, undefined, ctx(link));
		expect(trusted(command)).toEqual([realpathSync(real)]);
	});

	it("falls back to the given path when the worktree does not exist", async () => {
		const missing = join(root, "missing");
		expect(trusted(await resolveAgentCommand(AGY, undefined, ctx(missing)))).toEqual([missing]);
	});

	it("trusts no workspace for a task that runs someone else's branch, so agy asks the user", async () => {
		const command = await resolveAgentCommand(AGY, undefined, ctx(real), { foreignCode: true });
		const settings = JSON.parse(command.match(/--settings '(.*?)' -i/)![1]!.replaceAll("'\\''", "'"));
		expect(settings).not.toHaveProperty("trustedWorkspaces");
		expect(settings.permissions.allow.length).toBeGreaterThan(0);
		expect(trusted(await resolveAgentCommand(AGY, undefined, ctx(real), { foreignCode: false }))).toEqual([realpathSync(real)]);
	});

	it("spells the statusLine's CLI under the account home, not through ~", async () => {
		const settings = JSON.parse(
			(await resolveAgentCommand(AGY, undefined, ctx(real))).match(/--settings '(.*?)' -i/)![1]!.replaceAll("'\\''", "'"),
		);
		expect(settings.statusLine.command).toContain(`exec ${resolveAccountHome()}/.dev3.0/bin/dev3 statusline agy`);
		expect(settings.statusLine.command).not.toContain("~");
	});

	it("keeps the quota out of the statusLine while rate-limit tracking is off", async () => {
		const off = await resolveAgentCommand(AGY, undefined, ctx(real), { rateLimitTracking: false });
		expect(off).toContain("statusline agy --no-limits");
		const on = await resolveAgentCommand(AGY, undefined, ctx(real), { rateLimitTracking: true });
		expect(on).not.toContain("--no-limits");
	});
});
