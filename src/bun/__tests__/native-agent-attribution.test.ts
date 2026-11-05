import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rmSync, writeFileSync } from "node:fs";
import type { Task } from "../../shared/types";

const mocks = vi.hoisted(() => ({ nativeTaskPaneCommands: vi.fn() }));
vi.mock("../native-task-panes", () => ({ nativeTaskPaneCommands: mocks.nativeTaskPaneCommands }));

import { listNativeTaskAgents, writeNativeAgentAttribution } from "../native-agent-attribution";
import { dev3TaskTempPath } from "../temp-paths";

const TASK_ID = "attrib00-0000-0000-0000-000000000001";
const task = (over: Partial<Task> = {}) => ({ id: TASK_ID, terminalBackend: "native", ...over }) as Task;
const spawnScript = (n: number) => dev3TaskTempPath(TASK_ID, `spawn-${n}.sh`);
const huntScript = dev3TaskTempPath(TASK_ID, "bughunt-1-abc.sh");
const pane = (paneId: string, script: string, alive = true) => ({ paneId, sessionId: paneId, command: ["/bin/bash", script], shellPid: 1, alive });
const attribution = { agentCmd: "claude", agentId: "builtin-claude", configId: null, accountId: "a1" };

beforeEach(() => {
	mocks.nativeTaskPaneCommands.mockReset();
});
afterEach(() => {
	for (const n of [1, 2, 3]) rmSync(`${spawnScript(n)}.json`, { force: true });
	rmSync(`${huntScript}.json`, { force: true });
});

describe("listNativeTaskAgents", () => {
	it("returns alive spawn panes that have a sidecar", async () => {
		await writeNativeAgentAttribution(spawnScript(1), attribution);
		mocks.nativeTaskPaneCommands.mockResolvedValue([pane("p1", spawnScript(1))]);
		expect(await listNativeTaskAgents(task())).toEqual([{ ...attribution, paneId: "p1", shellPid: 1 }]);
	});

	it("skips dead, non-spawn and sidecar-less panes", async () => {
		await writeNativeAgentAttribution(spawnScript(1), attribution);
		await writeNativeAgentAttribution(spawnScript(2), attribution);
		writeFileSync(`${spawnScript(3)}.json`, "not json");
		mocks.nativeTaskPaneCommands.mockResolvedValue([
			pane("dead", spawnScript(1), false),
			pane("main", dev3TaskTempPath(TASK_ID, "launch.sh")),
			pane("bare", "/bin/zsh"),
			pane("nosidecar", spawnScript(9)),
			pane("invalid", spawnScript(3)),
			pane("ok", spawnScript(2)),
		]);
		expect((await listNativeTaskAgents(task())).map((a) => a.paneId)).toEqual(["ok"]);
	});

	it("lists a bug-hunter pane, but not the main pane or an unrelated script", async () => {
		await writeNativeAgentAttribution(huntScript, attribution);
		await writeNativeAgentAttribution(spawnScript(1), attribution);
		const mainScript = dev3TaskTempPath(TASK_ID, "launch.sh");
		mocks.nativeTaskPaneCommands.mockResolvedValue([
			pane("main", mainScript),
			pane("hunter", huntScript),
			pane("other", dev3TaskTempPath(TASK_ID, "devserver-1.sh")),
		]);
		expect((await listNativeTaskAgents(task())).map((a) => a.paneId)).toEqual(["hunter"]);
	});

	it("returns nothing for a non-native task without reading panes", async () => {
		expect(await listNativeTaskAgents(task({ terminalBackend: undefined }))).toEqual([]);
		expect(mocks.nativeTaskPaneCommands).not.toHaveBeenCalled();
	});

	it("returns nothing when the pane read fails", async () => {
		mocks.nativeTaskPaneCommands.mockRejectedValue(new Error("boom"));
		expect(await listNativeTaskAgents(task())).toEqual([]);
	});
});
