/**
 * The sandbox repo dev3 creates for a first-run user.
 *
 * Runs against a real git repository in a temp dir rather than a mocked one: the
 * whole point of the module is that the result is a repo dev3's own worktree code
 * can branch from, and a mocked `git` would assert nothing about that. The shared
 * spawn mock also strips the machine's git config, so these exercise the
 * no-identity path — which is the one a fresh laptop is actually on.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const TEST_HOME = vi.hoisted(() => `${process.env.DEV3_TEST_ROOT}/sandbox-project`);

vi.mock("../logger", () => ({
	createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock("../paths", () => ({
	DEV3_HOME: TEST_HOME,
	OPS_DIR: `${TEST_HOME}/ops`,
	SANDBOX_DIR: `${TEST_HOME}/sandbox`,
}));

vi.mock("../spawn", async () => {
	const { createSpawnMock } = await import("./git-test-helpers");
	return createSpawnMock();
});

const addProject = vi.fn();
const updateProject = vi.fn();
vi.mock("../data", () => ({
	addProject: (...args: unknown[]) => addProject(...args),
	updateProject: (...args: unknown[]) => updateProject(...args),
}));

import { createSandboxProject, SANDBOX_DEV_SCRIPT, SANDBOX_REPO_PATH } from "../sandbox-project";
import { SANDBOX_FIRST_PROMPT } from "../../shared/sandbox-prompts";

/** Reads state back with the machine's own git, never through the module's spawn. */
const git = (args: string[]) => spawnSync("git", args, { cwd: SANDBOX_REPO_PATH, encoding: "utf8" });

beforeEach(() => {
	addProject.mockReset();
	updateProject.mockReset();
	addProject.mockImplementation(async (path: string, name: string) => ({
		id: "p-sandbox",
		path,
		name,
		defaultBaseBranch: "main",
	}));
});

describe("createSandboxProject", () => {
	it("leaves a real repo on main with a commit in it", async () => {
		const result = await createSandboxProject();
		expect(result.ok).toBe(true);

		// A worktree can only be cut from a repo that has a branch AND a commit — an
		// unborn HEAD would make every task on this project fail to prepare.
		expect(git(["rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim()).toBe("main");
		expect(git(["rev-parse", "HEAD"]).status).toBe(0);
		expect(git(["status", "--porcelain"]).stdout.trim()).toBe("");

		expect(existsSync(join(SANDBOX_REPO_PATH, "README.md"))).toBe(true);
		// The page and its server are the point: the first task changes a colour the
		// user can SEE, and the dev-server button has something to run.
		expect(readFileSync(join(SANDBOX_REPO_PATH, "index.html"), "utf8")).toContain("Ship it");
		expect(readFileSync(join(SANDBOX_REPO_PATH, "server.js"), "utf8")).toContain("DEV3_PORT0");
		expect(addProject).toHaveBeenCalledWith(SANDBOX_REPO_PATH, "Sandbox");
	});

	it("re-opens the existing repo instead of re-seeding it", async () => {
		// The button stays reachable for as long as no other repository exists, so a
		// second click must not touch work the user did in the sandbox meanwhile.
		const marker = join(SANDBOX_REPO_PATH, "README.md");
		const before = readFileSync(marker, "utf8");
		git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "--allow-empty", "-m", "user work"]);
		const head = git(["rev-parse", "HEAD"]).stdout.trim();

		const result = await createSandboxProject();
		expect(result.ok).toBe(true);
		expect(readFileSync(marker, "utf8")).toBe(before);
		expect(git(["rev-parse", "HEAD"]).stdout.trim()).toBe(head);
	});

	it("pins the project's base branch when the stored record disagrees", async () => {
		addProject.mockResolvedValueOnce({ id: "p-old", path: SANDBOX_REPO_PATH, name: "Sandbox", defaultBaseBranch: "master" });
		await createSandboxProject();
		expect(updateProject).toHaveBeenCalledWith("p-old", {
			defaultBaseBranch: "main",
			sandbox: true,
			devScript: SANDBOX_DEV_SCRIPT,
			portCount: 1,
		});
	});

	it("gives the sandbox a dev server, because the first task changes a page", async () => {
		// Without a devScript the button on the task screen only offers to set one up,
		// and the tour's dev-server step would point at a dead end.
		await createSandboxProject();
		const fixes = updateProject.mock.calls[0]?.[1] as Record<string, unknown> | undefined;
		expect(fixes?.devScript).toBe(SANDBOX_DEV_SCRIPT);
		expect(fixes?.portCount).toBe(1);
	});

	it("documents the exact prompt the guided tour prefills", async () => {
		// The tour types this into the Create Task modal. If the README drifted from
		// it, the wizard would ask for work the repo never mentions.
		await createSandboxProject();
		expect(readFileSync(join(SANDBOX_REPO_PATH, "README.md"), "utf8")).toContain(SANDBOX_FIRST_PROMPT);
	});

	it("reports the failure instead of registering a project", async () => {
		addProject.mockRejectedValueOnce(new Error("projects.json is locked"));
		const result = await createSandboxProject();
		expect(result).toEqual({ ok: false, error: "Error: projects.json is locked" });
	});
});
