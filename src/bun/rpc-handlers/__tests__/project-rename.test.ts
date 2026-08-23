/**
 * Renaming a project through `updateProjectSettings`.
 *
 * `normalizeProjectName` is unit-tested on its own; what this file proves is the
 * CALL SITE — that the handler actually forwards a `name` to `data.updateProject`
 * (a field missing from the whitelist would silently drop the rename), that it
 * refuses a blank one instead of emptying the board label, and that it never
 * touches `path`, which every on-disk slug is derived from.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Project } from "../../../shared/types";

const mocks = vi.hoisted(() => ({
	getProject: vi.fn(),
	updateProject: vi.fn(),
	saveConfigToWinningLayer: vi.fn(async () => ({})),
	resolveProjectConfig: vi.fn(async (p: Project) => p),
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
	loadRepoConfigRaw: vi.fn(() => ({})),
	loadLocalConfigRaw: vi.fn(() => ({})),
	hasRepoConfig: vi.fn(() => false),
	hasLocalConfig: vi.fn(() => false),
	saveRepoConfig: vi.fn(),
	saveLocalConfig: vi.fn(),
	resolveOperationalProjectConfig: vi.fn(),
}));

// Stubbed wholesale rather than partially: the real module pulls `bun:ffi`,
// which the node-based vitest runner cannot resolve. Config extraction is not
// what this file is about — the `name` whitelist is.
vi.mock("../shared", () => ({
	extractConfigFromParams: () => ({}),
	getPushMessage: () => mocks.pushMessage,
	getSystemRequirements: vi.fn(),
	resolveBinaryPath: vi.fn(),
	setFocusMode: vi.fn(),
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const project: Project = {
	id: "p1",
	name: "old-name",
	path: "/Users/me/src/repo",
	setupScript: "",
	devScript: "",
	cleanupScript: "",
	defaultBaseBranch: "main",
	createdAt: "2026-01-01T00:00:00Z",
};

async function updateProjectSettings(params: Parameters<typeof import("../settings-config")["settingsConfigHandlers"]["updateProjectSettings"]>[0]) {
	const { settingsConfigHandlers } = await import("../settings-config");
	return settingsConfigHandlers.updateProjectSettings(params);
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.getProject.mockResolvedValue(project);
	mocks.updateProject.mockImplementation(async (_id: string, updates: Partial<Project>) => ({ ...project, ...updates }));
	mocks.saveConfigToWinningLayer.mockResolvedValue({});
	mocks.resolveProjectConfig.mockImplementation(async (p: Project) => p);
});

describe("updateProjectSettings — rename", () => {
	it("persists a trimmed name and pushes it so every surface relabels at once", async () => {
		const updated = await updateProjectSettings({ projectId: "p1", name: "  Fresh Name  " });
		expect(mocks.updateProject).toHaveBeenCalledWith("p1", expect.objectContaining({ name: "Fresh Name" }));
		expect(updated.name).toBe("Fresh Name");
		expect(mocks.pushMessage).toHaveBeenCalledWith("projectUpdated", { project: expect.objectContaining({ name: "Fresh Name" }) });
	});

	it("never writes `path` — every on-disk slug is derived from it", async () => {
		await updateProjectSettings({ projectId: "p1", name: "Fresh Name" });
		const [, updates] = mocks.updateProject.mock.calls[0];
		expect(updates).not.toHaveProperty("path");
	});

	it("rejects a blank name instead of leaving the board with no label", async () => {
		await expect(updateProjectSettings({ projectId: "p1", name: "   " })).rejects.toThrow(/Invalid project name/);
		expect(mocks.updateProject).not.toHaveBeenCalled();
	});

	it("rejects a name past the length cap", async () => {
		await expect(updateProjectSettings({ projectId: "p1", name: "x".repeat(121) })).rejects.toThrow(/Invalid project name/);
		expect(mocks.updateProject).not.toHaveBeenCalled();
	});

	it("leaves the name alone when the caller only changes something else", async () => {
		await updateProjectSettings({ projectId: "p1", sensitive: true });
		const [, updates] = mocks.updateProject.mock.calls[0];
		expect(updates).not.toHaveProperty("name");
		expect(updates).toMatchObject({ sensitive: true });
	});
});
