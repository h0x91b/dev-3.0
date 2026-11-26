import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdirSync, rmSync, symlinkSync } from "node:fs";
import type { Project } from "../../shared/types";
import { SPACE_REF_INVALID_PREFIX } from "../../shared/project-registration";

const ROOT = vi.hoisted(() => `${process.env.DEV3_TEST_ROOT}/project-registration`);
const DEV3_HOME = vi.hoisted(() => `${process.env.DEV3_TEST_ROOT}/project-registration/home`);

const mocks = vi.hoisted(() => ({
	projects: [] as Project[],
	virtualProjects: [] as Project[],
	cloneBaseDirectory: undefined as string | undefined,
	push: vi.fn(),
	addProject: vi.fn(),
	initAndAddProject: vi.fn(),
	cloneAndAddProject: vi.fn(),
}));

vi.mock("../logger", () => ({
	createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock("../paths", () => ({ DEV3_HOME, OPS_DIR: `${DEV3_HOME}/ops` }));
vi.mock("../file-lock", () => ({
	withFileLock: async <T>(_filePath: string, fn: () => Promise<T>): Promise<T> => fn(),
}));
vi.mock("../data", () => ({
	loadProjects: vi.fn(async () => mocks.projects.filter((p) => !p.deleted)),
	loadVirtualProjects: vi.fn(async () => mocks.virtualProjects),
}));
vi.mock("../settings", () => ({
	loadSettings: vi.fn(async () => ({ cloneBaseDirectory: mocks.cloneBaseDirectory })),
}));
vi.mock("../rpc-handlers/shared-pure", () => ({ getPushMessage: () => mocks.push }));
vi.mock("../rpc-handlers/app-handlers", () => ({
	appHandlers: {
		addProject: mocks.addProject,
		initAndAddProject: mocks.initAndAddProject,
		cloneAndAddProject: mocks.cloneAndAddProject,
	},
}));
// The real handlers only add a push on top of spaces-data; the data layer is what matters here.
vi.mock("../rpc-handlers/spaces", async () => {
	const spacesData = await import("../spaces-data");
	return {
		spacesHandlers: {
			getSpaces: () => spacesData.loadSpacesFile(),
			createSpace: (p: { name: string; projectIds: string[] }) => spacesData.createSpace(p.name, p.projectIds),
			setProjectSpaces: (p: { projectId: string; spaceIds: string[] }) => spacesData.setProjectSpaces(p.projectId, p.spaceIds),
		},
	};
});

import { changeProjectSpaces, cloneProject, createSpaceWith, registerProject } from "../project-registration";
import { _resetSpacesCache, createSpace, deleteSpace, loadSpacesFile } from "../spaces-data";

const REPO = `${ROOT}/repos/app`;
const CLONES = `${ROOT}/clones`;

function project(id: string, path: string, extra: Partial<Project> = {}): Project {
	return {
		id,
		name: path.split("/").pop() ?? id,
		path,
		setupScript: "",
		devScript: "",
		cleanupScript: "",
		defaultBaseBranch: "main",
		createdAt: "2026-10-18T00:00:00Z",
		...extra,
	};
}

/** The app's addProject: registers the folder and hands the record back. */
function addSucceeds(id = "new-project-id") {
	mocks.addProject.mockImplementation(async ({ path, name }: { path: string; name?: string }) => {
		const added = project(id, path, name ? { name } : {});
		mocks.projects.push(added);
		return { ok: true, project: added };
	});
}

async function spaceNamesOf(projectId: string): Promise<string[]> {
	const file = await loadSpacesFile();
	return file.spaces.filter((s) => !s.deleted && s.projectIds.includes(projectId)).map((s) => s.name);
}

beforeEach(() => {
	rmSync(ROOT, { recursive: true, force: true });
	mkdirSync(DEV3_HOME, { recursive: true });
	mkdirSync(REPO, { recursive: true });
	mkdirSync(CLONES, { recursive: true });
	_resetSpacesCache();
	mocks.projects = [project("other-1", `${ROOT}/repos/other`)];
	mocks.virtualProjects = [];
	mocks.cloneBaseDirectory = undefined;
	mocks.push.mockReset();
	mocks.addProject.mockReset();
	mocks.initAndAddProject.mockReset();
	mocks.cloneAndAddProject.mockReset();
});

describe("registerProject", () => {
	it("adds the folder through the app's handler and joins an existing space by name", async () => {
		const work = await createSpace("Work / Side", ["other-1"]);
		addSucceeds();

		const result = await registerProject({ path: REPO, spaces: ["work / side"] });

		expect(mocks.addProject).toHaveBeenCalledWith({ path: REPO, name: undefined });
		expect(result.outcome).toBe("added");
		expect(result.project.spaces).toEqual([{ id: work.id, name: "Work / Side" }]);
		expect(await spaceNamesOf("new-project-id")).toEqual(["Work / Side"]);
		expect(await spaceNamesOf("other-1")).toEqual(["Work / Side"]);
		expect(mocks.push).toHaveBeenCalledWith("projectAdded", { project: expect.objectContaining({ id: "new-project-id" }) });
	});

	it("creates a new space with the project as its first member", async () => {
		addSucceeds();

		const result = await registerProject({ path: REPO, name: "Side", newSpaces: ["Tools"] });

		expect(mocks.addProject).toHaveBeenCalledWith({ path: REPO, name: "Side" });
		expect(result.createdSpaces.map((s) => s.name)).toEqual(["Tools"]);
		expect(await spaceNamesOf("new-project-id")).toEqual(["Tools"]);
	});

	it("refuses an unknown space, or --new-space naming an existing one, BEFORE anything is added", async () => {
		await createSpace("Personal", ["other-1"]);
		addSucceeds();

		const attempt = registerProject({ path: REPO, spaces: ["Work / Side"] });

		await expect(attempt).rejects.toThrow(SPACE_REF_INVALID_PREFIX);
		await expect(attempt).rejects.toThrow(/Spaces: "Personal"/);
		await expect(registerProject({ path: REPO, newSpaces: ["personal"] })).rejects.toThrow(/already exists/);
		expect(mocks.addProject).not.toHaveBeenCalled();
	});

	it("refuses an already-registered folder without touching it or its spaces", async () => {
		mocks.projects.push(project("app-1", `${REPO}/`));
		await createSpace("Personal", ["app-1"]);
		await createSpace("Work / Side", ["other-1"]);

		const result = await registerProject({ path: REPO, spaces: ["Work / Side"] });

		expect(result.outcome).toBe("exists");
		expect(result.project.id).toBe("app-1");
		expect(result.project.spaces.map((s) => s.name)).toEqual(["Personal"]);
		expect(mocks.addProject).not.toHaveBeenCalled();
		expect(await spaceNamesOf("app-1")).toEqual(["Personal"]);
	});

	it("sees through a symlink when looking for a duplicate", async () => {
		const link = `${ROOT}/link-to-app`;
		symlinkSync(REPO, link);
		mocks.projects.push(project("app-1", REPO));

		expect((await registerProject({ path: link })).outcome).toBe("exists");
	});

	it("refuses a relative path, a missing folder, and --no-space together with --space", async () => {
		await expect(registerProject({ path: "repos/app" })).rejects.toThrow(/absolute path/);
		await expect(registerProject({ path: `${ROOT}/nope` })).rejects.toThrow(/does not exist/);
		await expect(registerProject({ path: REPO, noSpace: true, spaces: ["x"] })).rejects.toThrow(/--no-space/);
		expect(mocks.addProject).not.toHaveBeenCalled();
	});

	it("explains --init when the folder is not a git repository", async () => {
		mocks.addProject.mockResolvedValue({
			ok: false,
			error: "Selected folder is not a git repository",
			gitInit: { path: REPO, mode: "init", placeholder: "create", existingEntries: 2 },
		});

		await expect(registerProject({ path: REPO })).rejects.toThrow(/Pass --init/);
		await expect(registerProject({ path: REPO })).rejects.toThrow(/--no-git-workflow/);
	});

	it("adds the folder with the git workflow off under --no-git-workflow, and refuses it with --init", async () => {
		addSucceeds();
		const result = await registerProject({ path: REPO, noGitWorkflow: true });

		expect(mocks.addProject).toHaveBeenCalledWith({ path: REPO, name: undefined, gitWorkflow: false });
		expect(result.outcome).toBe("added");

		mocks.addProject.mockClear();
		await expect(registerProject({ path: REPO, init: true, noGitWorkflow: true })).rejects.toThrow(/--init cannot be combined/);
		expect(mocks.addProject).not.toHaveBeenCalled();
		expect(mocks.initAndAddProject).not.toHaveBeenCalled();
	});

	it("goes through the app's init flow with --init", async () => {
		mocks.initAndAddProject.mockResolvedValue({ ok: true, project: project("init-1", REPO) });

		const result = await registerProject({ path: REPO, init: true });

		expect(mocks.initAndAddProject).toHaveBeenCalledWith({ path: REPO, name: undefined, initNonEmpty: true });
		expect(mocks.addProject).not.toHaveBeenCalled();
		expect(result.outcome).toBe("added");
	});

	// A project removed earlier keeps its memberships, and addProject reactivates it.
	it("--no-space takes a re-added project out of the spaces it used to be in", async () => {
		await createSpace("Personal", ["other-1", "app-old"]);
		mocks.addProject.mockResolvedValue({ ok: true, project: project("app-old", REPO) });

		const result = await registerProject({ path: REPO, noSpace: true });

		expect(result.project.spaces).toEqual([]);
		expect(await spaceNamesOf("app-old")).toEqual([]);
	});
});

describe("cloneProject", () => {
	const URL = "https://example.com/group/app.git";

	function cloneSucceeds() {
		mocks.cloneAndAddProject.mockImplementation(async ({ baseDir, repoName }: { baseDir: string; repoName: string }) => ({
			ok: true,
			project: project("clone-1", `${baseDir}/${repoName}`),
		}));
	}

	it("refuses before cloning: no clone folder, a URL as the folder name, an unknown space", async () => {
		await expect(cloneProject({ url: URL })).rejects.toThrow(/No clone folder/);
		await expect(cloneProject({ url: URL, dir: CLONES, name: URL })).rejects.toThrow(/is a URL/);
		await expect(cloneProject({ url: URL, dir: CLONES, spaces: ["Nope"] })).rejects.toThrow(SPACE_REF_INVALID_PREFIX);
		expect(mocks.cloneAndAddProject).not.toHaveBeenCalled();
	});

	it("clones into the app's clone folder by default, naming it from the URL", async () => {
		mocks.cloneBaseDirectory = CLONES;
		cloneSucceeds();

		const result = await cloneProject({ url: URL });

		expect(mocks.cloneAndAddProject).toHaveBeenCalledWith({ url: URL, baseDir: CLONES, repoName: "app" });
		expect(result.project.path).toBe(`${CLONES}/app`);
	});

	it("reports an already-registered target without cloning", async () => {
		mocks.projects.push(project("app-1", `${CLONES}/app`));

		const result = await cloneProject({ url: URL, dir: CLONES });

		expect(result.outcome).toBe("exists");
		expect(mocks.cloneAndAddProject).not.toHaveBeenCalled();
	});

	// A clone can take minutes; the plan checked before it may be stale by the time it lands.
	it("re-checks --new-space after the clone, so a same-named space made meanwhile is not duplicated", async () => {
		mocks.cloneAndAddProject.mockImplementation(async ({ baseDir, repoName }: { baseDir: string; repoName: string }) => {
			await createSpace("Tools", ["other-1"]);
			return { ok: true, project: project("clone-1", `${baseDir}/${repoName}`) };
		});

		const attempt = cloneProject({ url: URL, dir: CLONES, newSpaces: ["Tools"] });

		await expect(attempt).rejects.toThrow(/was added, but setting its spaces failed: A space named "Tools" already exists/);
		await expect(attempt).rejects.not.toThrow(SPACE_REF_INVALID_PREFIX);
		expect((await loadSpacesFile()).spaces.filter((s) => s.name === "Tools")).toHaveLength(1);
	});

	it("re-checks --space after the clone, so a space deleted meanwhile is reported, not skipped", async () => {
		const target = await createSpace("Target", ["other-1"]);
		mocks.cloneAndAddProject.mockImplementation(async ({ baseDir, repoName }: { baseDir: string; repoName: string }) => {
			await deleteSpace(target.id);
			return { ok: true, project: project("clone-1", `${baseDir}/${repoName}`) };
		});

		await expect(cloneProject({ url: URL, dir: CLONES, spaces: ["Target"] })).rejects.toThrow(/was added, but setting its spaces failed: No space matches "Target"/);
	});

	it("surfaces a failed clone", async () => {
		mocks.cloneAndAddProject.mockResolvedValue({ ok: false, error: "Clone failed: repository not found" });

		await expect(cloneProject({ url: URL, dir: CLONES })).rejects.toThrow("Clone failed: repository not found");
	});
});

describe("changeProjectSpaces", () => {
	beforeEach(() => {
		mocks.projects.push(project("p1", `${ROOT}/repos/p1`));
	});

	it("set replaces the whole membership and reports a space it emptied", async () => {
		await createSpace("Old", ["p1"]);
		await createSpace("Shared", ["other-1", "p1"]);
		await createSpace("New", ["other-1"]);

		const result = await changeProjectSpaces({ projectId: "p1", mode: "set", spaces: ["New"] });

		expect(result.project.spaces.map((s) => s.name)).toEqual(["New"]);
		expect(result.deletedSpaces.map((s) => s.name)).toEqual(["Old"]);
		expect(await spaceNamesOf("other-1")).toEqual(["Shared", "New"]);
	});

	it("set with no spaces leaves every space", async () => {
		await createSpace("Shared", ["other-1", "p1"]);

		const result = await changeProjectSpaces({ projectId: "p1", mode: "set", spaces: [] });

		expect(result.project.spaces).toEqual([]);
	});

	it("add keeps the existing spaces and remove drops only the named one", async () => {
		await createSpace("A", ["other-1", "p1"]);
		await createSpace("B", ["other-1"]);

		await changeProjectSpaces({ projectId: "p1", mode: "add", spaces: ["B"] });
		expect(await spaceNamesOf("p1")).toEqual(["A", "B"]);

		await changeProjectSpaces({ projectId: "p1", mode: "remove", spaces: ["A"] });
		expect(await spaceNamesOf("p1")).toEqual(["B"]);
	});

	it("changes nothing for an unknown space, and refuses an unknown project", async () => {
		await createSpace("A", ["other-1", "p1"]);

		await expect(changeProjectSpaces({ projectId: "p1", mode: "set", spaces: ["A", "Nope"] })).rejects.toThrow(SPACE_REF_INVALID_PREFIX);
		expect(await spaceNamesOf("p1")).toEqual(["A"]);
		await expect(changeProjectSpaces({ projectId: "ghost", mode: "add", spaces: ["A"] })).rejects.toThrow(/Project not found/);
	});
});

describe("createSpaceWith", () => {
	it("creates a space with its members and names them", async () => {
		const space = await createSpaceWith({ name: " Tools ", projectIds: ["other-1"] });

		expect(space.name).toBe("Tools");
		expect(space.projects.map((p) => p.id)).toEqual(["other-1"]);
	});

	it("refuses a duplicate name and an unknown project", async () => {
		await createSpace("Personal", ["other-1"]);

		await expect(createSpaceWith({ name: "PERSONAL", projectIds: ["other-1"] })).rejects.toThrow(SPACE_REF_INVALID_PREFIX);
		await expect(createSpaceWith({ name: "Fresh", projectIds: ["ghost"] })).rejects.toThrow(/Project not found/);
		expect((await loadSpacesFile()).spaces.map((s) => s.name)).toEqual(["Personal"]);
	});
});
