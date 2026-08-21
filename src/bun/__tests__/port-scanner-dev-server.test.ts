import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Project, Task } from "../../shared/types";

vi.mock("../spawn", () => ({ spawn: vi.fn(), spawnSync: vi.fn() }));
vi.mock("../logger", () => ({
	createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock("../repo-config", () => ({ resolveOperationalProjectConfig: vi.fn() }));
vi.mock("../port-pool", () => ({ getPortAssignments: vi.fn(() => [] as number[]) }));

import { buildDevServerSummary, setNativeDevServerProbe } from "../port-scanner";
import { resolveOperationalProjectConfig } from "../repo-config";
import { getPortAssignments } from "../port-pool";

const project = { id: "p1", path: "/repo" } as Project;
const task = { id: "aaaabbbb-1111-2222-3333-444455556666", worktreePath: "/wt" } as Task;
/** The dev server's own tmux session, as `list-panes -a` reports it. */
function devPaneMap(panePid: number) {
	return new Map<string, number[]>([[`dev3-dev-${task.id.slice(0, 8)}`, [panePid]]]);
}
const tree = new Map<number, number[]>();
const lsof = "p100\ncnode\nn*:5173\np100\ncnode\nn*:9229\n";

function withDevScript(devScript: string) {
	(resolveOperationalProjectConfig as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ devScript });
}

beforeEach(() => {
	vi.clearAllMocks();
	(getPortAssignments as unknown as ReturnType<typeof vi.fn>).mockReturnValue([]);
	// Each case gets a fresh task id: `hasDevScript` is TTL-cached per task.
	task.id = `${Math.random().toString(16).slice(2, 10)}-1111-2222-3333-444455556666`;
});

describe("buildDevServerSummary", () => {
	it("reports no dev script, so the card renders no control", async () => {
		withDevScript("   ");
		const summary = await buildDevServerSummary(project, task, "dev3", lsof, tree, new Map());
		expect(summary).toMatchObject({ hasDevScript: false, running: false, ports: [], conflictPorts: [] });
	});

	it("lists the running server's ports ascending", async () => {
		withDevScript("bun run dev");
		const map = devPaneMap(100);
		const summary = await buildDevServerSummary(project, task, "dev3", lsof, tree, map);
		expect(summary).toMatchObject({ hasDevScript: true, running: true, ports: [5173, 9229] });
	});

	it("is stopped when the dev session is absent", async () => {
		withDevScript("bun run dev");
		const summary = await buildDevServerSummary(project, task, "dev3", lsof, tree, new Map());
		expect(summary).toMatchObject({ running: false, ports: [], conflictPorts: [] });
	});

	it("flags an assigned port squatted while the server is down", async () => {
		withDevScript("bun run dev");
		(getPortAssignments as unknown as ReturnType<typeof vi.fn>).mockReturnValue([5173]);
		const summary = await buildDevServerSummary(project, task, "dev3", lsof, tree, new Map());
		expect(summary).toMatchObject({ running: false, conflictPorts: [5173] });
	});

	it("reports a running server with nothing listening yet — the card reads it as starting", async () => {
		withDevScript("bun run dev");
		const map = devPaneMap(999);
		const summary = await buildDevServerSummary(project, task, "dev3", lsof, tree, map);
		expect(summary).toMatchObject({ running: true, ports: [] });
	});
});

describe("buildDevServerSummary on a native task", () => {
	it("takes its running state and ports from the injected probe, not from tmux", async () => {
		withDevScript("bun run dev");
		setNativeDevServerProbe(async () => ({ alive: true, rootPid: 100 }));
		try {
			// No dev session in the pane map at all — a native task never has one.
			const summary = await buildDevServerSummary(project, task, "dev3", lsof, tree, new Map());
			expect(summary).toMatchObject({ running: true, ports: [5173, 9229] });
		} finally {
			setNativeDevServerProbe(async () => null);
		}
	});
});
