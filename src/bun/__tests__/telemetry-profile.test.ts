import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
	loadProjects: vi.fn(),
	loadVirtualProjects: vi.fn(),
	loadTasks: vi.fn(),
	newTaskTerminalBackend: vi.fn(),
	readPreference: vi.fn(),
	getAllAgents: vi.fn(),
	loadSettings: vi.fn(),
	detectRosetta: vi.fn(),
	resolveInstallMethod: vi.fn(),
	resolveInstallDate: vi.fn(),
}));

vi.mock("../data", () => ({
	loadProjects: mocks.loadProjects,
	loadVirtualProjects: mocks.loadVirtualProjects,
	loadTasks: mocks.loadTasks,
	newTaskTerminalBackend: mocks.newTaskTerminalBackend,
}));
vi.mock("../terminal-backend-preference", () => ({
	readNewTaskTerminalBackendPreference: mocks.readPreference,
}));
vi.mock("../agents", () => ({ getAllAgents: mocks.getAllAgents }));
vi.mock("../settings", () => ({ loadSettings: mocks.loadSettings }));
vi.mock("../rosetta", () => ({ detectRosetta: mocks.detectRosetta }));
vi.mock("../self-update", () => ({ resolveInstallMethod: mocks.resolveInstallMethod }));
vi.mock("../install-date", () => ({ resolveInstallDate: mocks.resolveInstallDate }));

import { collectTelemetryProfile } from "../telemetry-profile";

const NOW = Date.UTC(2026, 7, 27);
const DAY = 86_400_000;

const project = (id: string) => ({ id, name: `name-of-${id}`, path: `/secret/${id}` }) as never;
const tasks = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `t${i}`, title: "secret" }));

beforeEach(() => {
	vi.clearAllMocks();
	mocks.loadProjects.mockResolvedValue([project("a"), project("b")]);
	mocks.loadVirtualProjects.mockResolvedValue([]);
	mocks.loadTasks.mockResolvedValue(tasks(3));
	mocks.newTaskTerminalBackend.mockReturnValue(null);
	mocks.readPreference.mockReturnValue(null);
	mocks.getAllAgents.mockResolvedValue([{ id: "a1", name: "Claude Code", isDefault: true }]);
	mocks.loadSettings.mockResolvedValue({ defaultAgentId: "a1" });
	mocks.detectRosetta.mockReturnValue(false);
	mocks.resolveInstallMethod.mockReturnValue("brew-formula");
	mocks.resolveInstallDate.mockResolvedValue(NOW - 100 * DAY);
});

describe("collectTelemetryProfile", () => {
	it("reports counts as buckets, never as numbers", async () => {
		mocks.loadTasks.mockResolvedValue(tasks(60));
		const profile = await collectTelemetryProfile(NOW);
		expect(profile.projectCountBucket).toBe("2-5");
		expect(profile.taskCountBucket).toBe("51-200");
	});

	it("counts tasks across every board, real and virtual", async () => {
		mocks.loadVirtualProjects.mockResolvedValue([project("ops")]);
		mocks.loadTasks.mockResolvedValue(tasks(4));
		const profile = await collectTelemetryProfile(NOW);
		// 3 boards × 4 tasks = 12
		expect(profile.projectCountBucket).toBe("2-5");
		expect(profile.taskCountBucket).toBe("11-50");
	});

	it("turns the install date into an age bucket", async () => {
		mocks.resolveInstallDate.mockResolvedValue(NOW);
		expect((await collectTelemetryProfile(NOW)).installAgeBucket).toBe("day-0");
		mocks.resolveInstallDate.mockResolvedValue(NOW - 100 * DAY);
		expect((await collectTelemetryProfile(NOW)).installAgeBucket).toBe("month-03");
	});

	it("names the default agent the way a launch resolves it", async () => {
		expect((await collectTelemetryProfile(NOW)).defaultAgent).toBe("Claude Code");
	});

	it("falls back to the flagged default when the settings id names nothing", async () => {
		mocks.loadSettings.mockResolvedValue({ defaultAgentId: "gone" });
		expect((await collectTelemetryProfile(NOW)).defaultAgent).toBe("Claude Code");
	});

	it("derives an OS version, which the User-Agent cannot be trusted for", async () => {
		expect((await collectTelemetryProfile(NOW)).osVersion).toMatch(/^\d/);
	});

	it("marks a translated Intel build, which the User-Agent cannot", async () => {
		mocks.detectRosetta.mockReturnValue(true);
		expect((await collectTelemetryProfile(NOW)).cpuArch).toBe(`${process.arch}-rosetta`);
	});

	it("reports the backend a task created right now would get", async () => {
		expect((await collectTelemetryProfile(NOW)).terminalBackend).toBe("tmux");
		mocks.newTaskTerminalBackend.mockReturnValue("native");
		expect((await collectTelemetryProfile(NOW)).terminalBackend).toBe("native");
	});

	// Analytics must never be why a launch fails.
	it("survives every probe throwing and still returns a whole profile", async () => {
		mocks.loadProjects.mockRejectedValue(new Error("no disk"));
		mocks.getAllAgents.mockRejectedValue(new Error("no agents"));
		mocks.readPreference.mockImplementation(() => { throw new Error("no settings"); });
		mocks.resolveInstallMethod.mockImplementation(() => { throw new Error("no path"); });
		mocks.resolveInstallDate.mockRejectedValue(new Error("no stat"));

		const profile = await collectTelemetryProfile(NOW);
		expect(profile).toEqual({
			cpuArch: process.arch,
			osVersion: profile.osVersion,
			installType: "unknown",
			terminalBackend: "unknown",
			defaultAgent: "unknown",
			projectCountBucket: "0",
			taskCountBucket: "0",
			installAgeBucket: "day-0",
		});
	});

	it("keeps counting when one board is unreadable", async () => {
		mocks.loadTasks
			.mockRejectedValueOnce(new Error("corrupt"))
			.mockResolvedValueOnce(tasks(20));
		expect((await collectTelemetryProfile(NOW)).taskCountBucket).toBe("11-50");
	});

	// The telemetry contract: names, paths and titles never leave the machine.
	it("leaks no project name, path or task title into the profile", async () => {
		const serialized = JSON.stringify(await collectTelemetryProfile(NOW));
		expect(serialized).not.toContain("name-of-");
		expect(serialized).not.toContain("/secret/");
		expect(serialized).not.toContain("secret");
	});
});
