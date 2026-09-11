/**
 * `useRepoConfig: false` at the RPC boundary.
 *
 * The cascade itself is covered in `bun/__tests__/repo-config.test.ts`; what this
 * file proves is the HANDLER behaviour the user notices: a Project Settings save
 * lands in dev3's own data instead of a repo file, nothing opens a `.dev3` file
 * while the switch is off, and the file editors refuse rather than writing a file
 * dev3 would never read back.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Project } from "../../../shared/types";

const mocks = vi.hoisted(() => ({
	getProject: vi.fn(),
	updateProject: vi.fn(),
	saveConfigToWinningLayer: vi.fn(async () => ({})),
	resolveProjectConfig: vi.fn(async (p: Project) => p),
	loadRepoConfigRaw: vi.fn(() => ({ setupScript: "from-repo-file" })),
	loadLocalConfigRaw: vi.fn(() => ({ setupScript: "from-local-file" })),
	getConfigSources: vi.fn(async () => [{ field: "setupScript", source: "repo" as const }]),
	saveRepoConfig: vi.fn(),
	saveRepoLocalConfig: vi.fn(),
	pushMessage: vi.fn(),
}));

vi.mock("electrobun/bun", () => ({
	PATHS: { VIEWS_FOLDER: "/fake-bundle/Resources/app/views/" },
	Utils: { showNotification: vi.fn(), quit: vi.fn() },
	Updater: {
		localInfo: {
			version: vi.fn().mockResolvedValue("0.0.0-test"),
			hash: vi.fn().mockResolvedValue("deadbeef"),
			channel: vi.fn().mockResolvedValue("dev"),
		},
		checkForUpdate: vi.fn(),
		downloadUpdate: vi.fn(),
		updateInfo: vi.fn().mockReturnValue(null),
		applyUpdate: vi.fn(),
	},
}));

vi.mock("../../data", () => ({
	getProject: mocks.getProject,
	updateProject: mocks.updateProject,
}));

vi.mock("../../repo-config", () => ({
	saveConfigToWinningLayer: mocks.saveConfigToWinningLayer,
	resolveProjectConfig: mocks.resolveProjectConfig,
	loadRepoConfigRaw: mocks.loadRepoConfigRaw,
	loadLocalConfigRaw: mocks.loadLocalConfigRaw,
	getConfigSources: mocks.getConfigSources,
	hasRepoConfig: vi.fn(() => true),
	hasLocalConfig: vi.fn(() => false),
	saveRepoConfig: mocks.saveRepoConfig,
	saveRepoLocalConfig: mocks.saveRepoLocalConfig,
	resolveOperationalProjectConfig: vi.fn(),
}));

// `../shared` pulls `bun:ffi`, which the node-based runner cannot resolve. Only
// the config-key extraction matters here, so it is the one part kept honest.
vi.mock("../shared", () => ({
	extractConfigFromParams: (params: Record<string, unknown>) => {
		const out: Record<string, unknown> = {};
		for (const key of ["setupScript", "devScript", "cleanupScript", "env"]) {
			if (params[key] !== undefined) out[key] = params[key];
		}
		return out;
	},
	getPushMessage: () => mocks.pushMessage,
	getSystemRequirements: vi.fn(),
	resolveBinaryPath: vi.fn(),
	setFocusMode: vi.fn(),
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const baseProject: Project = {
	id: "p1",
	name: "repo",
	path: "/Users/me/src/repo",
	setupScript: "",
	devScript: "",
	cleanupScript: "",
	defaultBaseBranch: "main",
	createdAt: "2026-01-01T00:00:00Z",
};

async function handlers() {
	const { settingsConfigHandlers } = await import("../settings-config");
	return settingsConfigHandlers;
}

function withProject(overrides: Partial<Project> = {}) {
	mocks.getProject.mockResolvedValue({ ...baseProject, ...overrides });
}

beforeEach(() => {
	vi.clearAllMocks();
	withProject();
	mocks.updateProject.mockImplementation(async (_id: string, updates: Partial<Project>) => ({ ...baseProject, ...updates }));
	mocks.saveConfigToWinningLayer.mockResolvedValue({});
	mocks.resolveProjectConfig.mockImplementation(async (p: Project) => p);
	mocks.loadRepoConfigRaw.mockReturnValue({ setupScript: "from-repo-file" });
	mocks.loadLocalConfigRaw.mockReturnValue({ setupScript: "from-local-file" });
	mocks.getConfigSources.mockResolvedValue([{ field: "setupScript", source: "repo" }]);
});

describe("updateProjectSettings — save target", () => {
	it("persists the switch itself onto the project record", async () => {
		const updated = await (await handlers()).updateProjectSettings({ projectId: "p1", useRepoConfig: false });
		expect(mocks.updateProject).toHaveBeenCalledWith("p1", expect.objectContaining({ useRepoConfig: false }));
		expect(updated.useRepoConfig).toBe(false);
	});

	it("keeps every field in dev3's data while the switch is off", async () => {
		withProject({ useRepoConfig: false });
		await (await handlers()).updateProjectSettings({ projectId: "p1", setupScript: "bun install" });
		expect(mocks.saveConfigToWinningLayer).not.toHaveBeenCalled();
		const [, updates] = mocks.updateProject.mock.calls[0];
		expect(updates).toMatchObject({ setupScript: "bun install" });
	});

	it("writes no repo file on the very save that switches repo config off", async () => {
		await (await handlers()).updateProjectSettings({ projectId: "p1", useRepoConfig: false, setupScript: "bun install" });
		expect(mocks.saveConfigToWinningLayer).not.toHaveBeenCalled();
		const [, updates] = mocks.updateProject.mock.calls[0];
		expect(updates).toMatchObject({ useRepoConfig: false, setupScript: "bun install" });
	});

	it("still routes a save into the winning file layer by default", async () => {
		await (await handlers()).updateProjectSettings({ projectId: "p1", setupScript: "bun install" });
		expect(mocks.saveConfigToWinningLayer).toHaveBeenCalledWith("/Users/me/src/repo", { setupScript: "bun install" });
	});
});

describe("reading .dev3 files while the switch is off", () => {
	it("getProjectConfigs opens neither file and returns empty layers", async () => {
		withProject({ useRepoConfig: false });
		const configs = await (await handlers()).getProjectConfigs({ projectId: "p1", worktreePath: "/wt" });
		expect(configs).toEqual({ repo: {}, local: {} });
		expect(mocks.loadRepoConfigRaw).not.toHaveBeenCalled();
		expect(mocks.loadLocalConfigRaw).not.toHaveBeenCalled();
	});

	it("getRepoConfigSources attributes nothing to a file", async () => {
		withProject({ useRepoConfig: false });
		expect(await (await handlers()).getRepoConfigSources({ projectId: "p1" })).toEqual([]);
		expect(mocks.getConfigSources).not.toHaveBeenCalled();
	});

	it("both still read the files by default", async () => {
		const h = await handlers();
		expect(await h.getProjectConfigs({ projectId: "p1" })).toEqual({
			repo: { setupScript: "from-repo-file" },
			local: { setupScript: "from-local-file" },
		});
		expect(await h.getRepoConfigSources({ projectId: "p1" })).toEqual([{ field: "setupScript", source: "repo" }]);
	});
});

describe("writing .dev3 files while the switch is off", () => {
	it("saveRepoConfig refuses instead of creating an unread file", async () => {
		withProject({ useRepoConfig: false });
		await expect((await handlers()).saveRepoConfig({ projectId: "p1", setupScript: "x" }))
			.rejects.toThrow(/disabled for this project/);
		expect(mocks.saveRepoConfig).not.toHaveBeenCalled();
	});

	it("saveLocalConfig refuses too", async () => {
		withProject({ useRepoConfig: false });
		await expect((await handlers()).saveLocalConfig({ projectId: "p1", setupScript: "x" }))
			.rejects.toThrow(/disabled for this project/);
		expect(mocks.saveRepoLocalConfig).not.toHaveBeenCalled();
	});

	it("both write normally by default", async () => {
		const h = await handlers();
		await h.saveRepoConfig({ projectId: "p1", setupScript: "x" });
		await h.saveLocalConfig({ projectId: "p1", setupScript: "y" });
		expect(mocks.saveRepoConfig).toHaveBeenCalledWith("/Users/me/src/repo", { setupScript: "x" });
		expect(mocks.saveRepoLocalConfig).toHaveBeenCalledWith("/Users/me/src/repo", { setupScript: "y" });
	});
});
