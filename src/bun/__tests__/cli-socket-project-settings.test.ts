import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Project, ProjectSettingsUpdate, Task } from "../../shared/types";

vi.mock("../data", () => ({ getProject: vi.fn() }));
vi.mock("../cli-socket/task-resolution", () => ({ resolveTaskAcrossProjects: vi.fn() }));
vi.mock("../rpc-handlers/settings-config", () => ({ settingsConfigHandlers: { updateProjectSettings: vi.fn() } }));

import * as data from "../data";
import { resolveTaskAcrossProjects } from "../cli-socket/task-resolution";
import { settingsConfigHandlers } from "../rpc-handlers/settings-config";
import { projectSettingsHandlers } from "../cli-socket/project-settings-commands";

const getProject = vi.mocked(data.getProject);
const resolveTask = vi.mocked(resolveTaskAcrossProjects);
const update = vi.mocked(settingsConfigHandlers.updateProjectSettings);

function makeProject(overrides: Partial<Project> = {}): Project {
	return {
		id: "proj-1",
		name: "App",
		path: "/repo/app",
		setupScript: "",
		devScript: "",
		cleanupScript: "",
		defaultBaseBranch: "main",
		createdAt: "2026-11-16T00:00:00Z",
		...overrides,
	};
}

function taskOf(taskType?: Task["taskType"]) {
	return { task: { id: "task-1", taskType } as Task, project: makeProject() } as Awaited<ReturnType<typeof resolveTaskAcrossProjects>>;
}

let stored: Project;

beforeEach(() => {
	vi.clearAllMocks();
	stored = makeProject();
	getProject.mockImplementation(async () => stored);
	update.mockImplementation(async (params: { projectId: string } & ProjectSettingsUpdate) => {
		const { projectId: _id, ...fields } = params;
		stored = { ...stored, ...fields, ...(fields.gitWorkflow === true ? { gitWorkflow: undefined } : {}) } as Project;
		return stored;
	});
});

const get = projectSettingsHandlers["projects.settings.get"]!;
const set = projectSettingsHandlers["projects.settings.set"]!;

describe("projects.settings.get", () => {
	it("fills in the defaults an absent field means, and reports the stored switches", async () => {
		expect(await get({ projectId: "proj-1" })).toEqual({
			name: "App",
			gitWorkflow: true,
			storageRoot: "home",
			useRepoConfig: true,
			boardCopy: false,
			boardCopyMessages: false,
		});
		stored = makeProject({ gitWorkflow: false, storageRoot: "project", useRepoConfig: false, boardCopy: true });
		expect(await get({ projectId: "proj-1" })).toMatchObject({ gitWorkflow: false, storageRoot: "project", useRepoConfig: false, boardCopy: true });
	});
});

describe("projects.settings.set", () => {
	it("passes one typed field to updateProjectSettings and reports before and after", async () => {
		const result = await set({ projectId: "proj-1", key: "gitWorkflow", value: false });
		expect(update).toHaveBeenCalledWith({ projectId: "proj-1", gitWorkflow: false });
		expect(result).toEqual({ key: "gitWorkflow", previous: true, value: false });
		// On/off words from a raw socket caller are typed too.
		await set({ projectId: "proj-1", key: "boardCopy", value: "on" });
		expect(update).toHaveBeenCalledWith({ projectId: "proj-1", boardCopy: true });
	});

	it("refuses an unknown key, a protected key and a bad value without writing", async () => {
		await expect(set({ projectId: "proj-1", key: "sensitive", value: "off" })).rejects.toThrow(/Unknown project setting "sensitive"/);
		await expect(set({ projectId: "proj-1", key: "storageRoot", value: "elsewhere" })).rejects.toThrow(/home or project/);
		await expect(set({ projectId: "proj-1", key: "name", value: "  " })).rejects.toThrow(/blank/);
		expect(update).not.toHaveBeenCalled();
	});

	it("lets the user and coordinators change a switch, and refuses any other task", async () => {
		resolveTask.mockResolvedValueOnce(taskOf(undefined));
		await expect(set({ projectId: "proj-1", key: "gitWorkflow", value: false, sourceTaskId: "task-1" })).rejects.toThrow(/^project-setting-forbidden: /);
		expect(update).not.toHaveBeenCalled();

		resolveTask.mockResolvedValueOnce(taskOf("coordinator"));
		await expect(set({ projectId: "proj-1", key: "gitWorkflow", value: false, sourceTaskId: "task-1" })).resolves.toMatchObject({ value: false });

		await expect(set({ projectId: "proj-1", key: "gitWorkflow", value: true })).resolves.toMatchObject({ previous: false, value: true });
		expect(update).toHaveBeenCalledTimes(2);
	});

	it("refuses boardCopyMessages on while boardCopy is off, and allows it once boardCopy is on", async () => {
		await expect(set({ projectId: "proj-1", key: "boardCopyMessages", value: "on" }))
			.rejects.toThrow(/^project-setting-unavailable: boardCopyMessages needs boardCopy\. Turn boardCopy on first/);
		expect(update).not.toHaveBeenCalled();

		await expect(set({ projectId: "proj-1", key: "boardCopyMessages", value: "off" })).resolves.toMatchObject({ value: false });
		stored = makeProject({ boardCopy: true });
		await expect(set({ projectId: "proj-1", key: "boardCopyMessages", value: "on" })).resolves.toMatchObject({ previous: false, value: true });
	});

	it("refuses boardCopy on for an operations board instead of reporting it already off", async () => {
		stored = makeProject({ kind: "virtual" });
		await expect(set({ projectId: "proj-1", key: "boardCopy", value: "on" }))
			.rejects.toThrow(/^project-setting-unavailable: Operations boards have no project folder/);
		expect(update).not.toHaveBeenCalled();
		await expect(set({ projectId: "proj-1", key: "boardCopy", value: "off" })).resolves.toMatchObject({ value: false });
	});

	it("checks who asks before what the project can take", async () => {
		resolveTask.mockResolvedValueOnce(taskOf(undefined));
		await expect(set({ projectId: "proj-1", key: "boardCopyMessages", value: "on", sourceTaskId: "task-1" })).rejects.toThrow(/^project-setting-forbidden: /);
	});

	it("surfaces updateProjectSettings' own refusal", async () => {
		update.mockRejectedValueOnce(new Error("Finish 1 running task(s) before switching the git workflow"));
		await expect(set({ projectId: "proj-1", key: "gitWorkflow", value: false })).rejects.toThrow(/Finish 1 running task/);
	});
});
