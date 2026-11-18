import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
	splitWindow: vi.fn(async () => ({ paneId: "%5", stderr: "" })),
	newWindow: vi.fn(async () => ({ paneId: "%6", stderr: "" })),
	selectPane: vi.fn(async () => {}),
}));

vi.mock("../tmux", () => ({
	tmux: { splitWindow: mocks.splitWindow, newWindow: mocks.newWindow, selectPane: mocks.selectPane },
	DEFAULT_TMUX_SOCKET: "dev3",
	TmuxError: class TmuxError extends Error {},
	taskSessionName: (id: string) => `dev3-${id.slice(0, 8)}`,
}));
vi.mock("../package-scripts", () => ({ resolveRunnerCommand: () => "npm run build" }));
vi.mock("../makefile", () => ({ resolveMakeCommand: () => "make build" }));
vi.mock("../logger", () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));

import { runScript } from "../script-runner";

beforeEach(() => vi.clearAllMocks());

const base = { taskId: "abcd1234-full-id", worktreePath: "/tmp/wt", scriptName: "build", source: "package" as const, runner: "npm" as never };

describe("runScript focus", () => {
	it("a user-chosen split focuses the new pane", async () => {
		await runScript({ ...base, placement: "right" });
		expect(mocks.splitWindow).toHaveBeenCalledWith(expect.objectContaining({ focus: true }));
	});

	it("a user-chosen window focuses the new window", async () => {
		await runScript({ ...base, placement: "window" });
		expect(mocks.newWindow).toHaveBeenCalledWith(expect.objectContaining({ focus: true }));
	});
});
