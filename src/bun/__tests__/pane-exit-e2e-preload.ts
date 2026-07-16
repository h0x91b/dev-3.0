import { mock } from "bun:test";
import type { PaneSessionEntry } from "../../shared/types";
import { cleanupTestIsolation, configureTestIsolation } from "../../../test-isolation";

const testRoot = configureTestIsolation("pane-e2e");
process.once("exit", () => cleanupTestIsolation(testRoot));

mock.module("electrobun/bun", () => ({
	PATHS: { VIEWS_FOLDER: "/fake" },
	Utils: { showMessageBox() {}, showNotification() {}, openFileDialog() {}, quit() {} },
	Updater: { localInfo: { channel: () => "dev" } },
}));

// Shared mutable state — the e2e script reads/writes this via the mocked data module
(globalThis as any).__e2eSessionState = null as { panes: PaneSessionEntry[] } | null;
(globalThis as any).__e2eTask = null as any;
(globalThis as any).__e2eProject = null as any;

mock.module("../data", () => ({
	updateTask: async (_proj: any, _taskId: string, updates: any) => {
		if (updates.sessionState) (globalThis as any).__e2eSessionState = updates.sessionState;
		return { ...(globalThis as any).__e2eTask, ...updates };
	},
	getTask: async () => ({ ...(globalThis as any).__e2eTask, sessionState: (globalThis as any).__e2eSessionState }),
	loadProjects: async () => [(globalThis as any).__e2eProject],
	loadVirtualProjects: async () => [],
	getProject: async () => (globalThis as any).__e2eProject,
	addTask: async () => ({}),
	loadTasks: async () => [],
}));

mock.module("../agents", () => ({
	resolveCommandForProject: async () => ({
		command: "exec sleep 999",
		extraEnv: {},
		agent: null,
		config: null,
	}),
	resolveCommandForAgent: async () => ({
		command: "exec sleep 999",
		extraEnv: {},
		agent: null,
		config: null,
	}),
	supportsPreAssignedSessionId: () => false,
	ensureClaudeTrust: async () => {},
	ensureCodexTrust: async () => {},
	ensureGeminiTrust: async () => {},
	isClaudeCommand: () => false,
	getAllAgents: () => [],
	buildResumeCommand: () => null,
}));

mock.module("../agent-hooks", () => ({
	setupAgentHooks: () => {},
}));

mock.module("../settings", () => ({
	loadSettings: async () => ({}),
	loadSettingsSync: () => ({}),
	recordFavoriteUsages: async () => {},
	saveSettings: async () => {},
}));

mock.module("../port-pool", () => ({
	allocatePorts: async () => [],
	getPortAssignments: () => [],
	buildPortEnv: () => ({}),
}));

mock.module("../port-scanner", () => ({
	buildProcessTree: async () => new Map(),
	clearPortDataForTask: () => {},
	collectDescendants: () => [],
	collectTaskPids: async () => new Set(),
	findPortHolders: async () => [],
	getLsofOutput: async () => "",
	getPortsForTask: () => [],
	getSessionPanePids: () => [],
	parseLsofOutput: () => [],
	scanTaskPorts: () => [],
	waitForPortsFree: async () => [],
}));

mock.module("../resource-monitor", () => ({
	getResourceUsage: () => undefined,
}));

mock.module("../repo-config", () => ({
	resolveProjectConfig: (_proj: any) => _proj,
	resolveOperationalProjectConfig: (_proj: any) => _proj,
	migrateProjectConfig: () => {},
	loadRepoConfigRaw: () => ({}),
}));
