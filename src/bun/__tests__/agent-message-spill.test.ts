import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../logger", () => ({
	createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const getProject = vi.fn();
vi.mock("../data", () => ({
	getProject: (...args: unknown[]) => getProject(...args),
}));

const taskDirRoot = `/tmp/dev3-message-spill-test-${process.pid}`;
vi.mock("../git", () => ({
	taskDir: () => taskDirRoot,
}));

import { readFile, rm } from "node:fs/promises";
import { AGENT_MESSAGE_SPILL_THRESHOLD_BYTES, type Task } from "../../shared/types";
import { PANE_INPUT_LIMITS, utf8Length } from "../../shared/pane-input";
import { spillOversizedAgentMessage } from "../agent-message-spill";

const task = { id: "t1", projectId: "p1" } as Task;

beforeEach(async () => {
	vi.clearAllMocks();
	getProject.mockResolvedValue({ id: "p1", path: "/tmp/proj" });
	await rm(taskDirRoot, { recursive: true, force: true });
});

describe("a body a pane can carry", () => {
	it("travels as text, untouched, and writes nothing", async () => {
		const result = await spillOversizedAgentMessage(task, "fix the retry loop");
		expect(result).toEqual({ text: "fix the retry loop", spilledPath: null });
		expect(getProject).not.toHaveBeenCalled();
	});

	it("still travels as text at exactly the threshold", async () => {
		const text = "x".repeat(AGENT_MESSAGE_SPILL_THRESHOLD_BYTES);
		const result = await spillOversizedAgentMessage(task, text);
		expect(result.spilledPath).toBeNull();
	});

	// The threshold is UTF-8 bytes, not characters: a Cyrillic body is two bytes per
	// character, and counting characters used to let it through at twice its real size.
	it("measures bytes, so a two-byte-per-char body spills at half the character count", async () => {
		const text = "я".repeat(AGENT_MESSAGE_SPILL_THRESHOLD_BYTES / 2 + 1);
		expect(text.length).toBeLessThan(AGENT_MESSAGE_SPILL_THRESHOLD_BYTES);
		const result = await spillOversizedAgentMessage(task, text);
		expect(result.spilledPath).not.toBeNull();
	});
});

describe("a body too large to type", () => {
	it("is written whole to a file and replaced by a pointer to it", async () => {
		const text = "y".repeat(AGENT_MESSAGE_SPILL_THRESHOLD_BYTES + 1);
		const result = await spillOversizedAgentMessage(task, text);
		expect(result.spilledPath).toMatch(new RegExp(`^${taskDirRoot}/messages/message-.*\\.md$`));
		expect(await readFile(result.spilledPath!, "utf8")).toBe(text);
		expect(result.text).toContain(result.spilledPath);
		expect(result.text).not.toContain(text);
	});

	it("produces a pointer that itself fits a single tmux send", async () => {
		const result = await spillOversizedAgentMessage(task, "z".repeat(80_000));
		expect(utf8Length(result.text)).toBeLessThan(PANE_INPUT_LIMITS.maxStageBytes);
	});
});
