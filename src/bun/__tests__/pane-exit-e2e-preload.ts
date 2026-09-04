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

const realData = await import("../data");
mock.module("../data", () => ({
	...realData,
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

// Spread the REAL module so the mock can never go stale: an enumerated export list
// silently drops a name the moment agents.ts grows one, and the whole script then dies
// at import time with zero tests run (that is exactly how this suite rotted).
const realAgents = await import("../agents");

mock.module("../agents", () => ({
	...realAgents,
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

const realAgentHooks = await import("../agent-hooks");
mock.module("../agent-hooks", () => ({
	...realAgentHooks,
	setupAgentHooks: () => {},
}));

const realSettings = await import("../settings");
mock.module("../settings", () => ({
	...realSettings,
	loadSettings: async () => ({}),
	loadSettingsSync: () => ({}),
	recordFavoriteUsages: async () => {},
	saveSettings: async () => {},
}));

const realPortPool = await import("../port-pool");
mock.module("../port-pool", () => ({
	...realPortPool,
	allocatePorts: async () => [],
	getPortAssignments: () => [],
	buildPortEnv: () => ({}),
}));

const realPortScanner = await import("../port-scanner");
mock.module("../port-scanner", () => ({
	...realPortScanner,
	buildProcessTree: async () => new Map(),
	clearDevServerSummaryForTask: () => {},
	schedulePortScanSoon: () => {},
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

const realResourceMonitor = await import("../resource-monitor");
mock.module("../resource-monitor", () => ({
	...realResourceMonitor,
	getResourceUsage: () => undefined,
}));

const realRepoConfig = await import("../repo-config");
mock.module("../repo-config", () => ({
	...realRepoConfig,
	resolveProjectConfig: (_proj: any) => _proj,
	resolveOperationalProjectConfig: (_proj: any) => _proj,
	migrateProjectConfig: () => {},
	loadRepoConfigRaw: () => ({}),
}));
