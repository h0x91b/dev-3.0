import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

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
import { wrapAgentMessage } from "../../shared/agent-message-envelope";
import { spillOversizedAgentMessage } from "../agent-message-spill";

const task = { id: "t1", projectId: "p1" } as Task;

beforeEach(async () => {
	vi.clearAllMocks();
	getProject.mockResolvedValue({ id: "p1", path: "/tmp/proj" });
	await rm(taskDirRoot, { recursive: true, force: true });
});

// beforeEach alone leaves the LAST run's directory on disk, one per pid, forever.
afterAll(async () => {
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

// The pty chunks what is TYPED, and the envelope's header (sender, title, subject,
// reply command) is 200–400 bytes of it — so a body under the threshold is split all
// the same once its header is added. Measured on the envelope for exactly that reason.
describe("the threshold is measured on the typed envelope, not the body", () => {
	const SOURCE = {
		taskId: "02e47a28-0000-0000-0000-000000000000",
		seq: 1786,
		title: "Review of #1636 about pasting prompts through per-send tmux buffers",
		projectId: "p1",
	};
	const SUBJECT = "a subject long enough to matter to the first read";

	it("spills a body that fits alone but whose envelope does not", async () => {
		const body = "b".repeat(AGENT_MESSAGE_SPILL_THRESHOLD_BYTES - 200);
		expect(utf8Length(body)).toBeLessThan(AGENT_MESSAGE_SPILL_THRESHOLD_BYTES);
		expect(utf8Length(wrapAgentMessage(body, SOURCE, "p1", SUBJECT)))
			.toBeGreaterThan(AGENT_MESSAGE_SPILL_THRESHOLD_BYTES);

		const result = await spillOversizedAgentMessage(task, body, { source: SOURCE, subject: SUBJECT });

		expect(result.spilledPath).not.toBeNull();
		expect(await readFile(result.spilledPath!, "utf8")).toBe(body);
	});

	it("leaves a body whose whole envelope fits as text", async () => {
		const body = "b".repeat(300);
		const result = await spillOversizedAgentMessage(task, body, { source: SOURCE, subject: SUBJECT });

		expect(result).toEqual({ text: body, spilledPath: null });
	});

	// A human's own message is typed bare, so there is no header to account for.
	it("measures the raw text when there is no envelope", async () => {
		const text = "h".repeat(AGENT_MESSAGE_SPILL_THRESHOLD_BYTES - 10);
		const result = await spillOversizedAgentMessage(task, text, null);

		expect(result.spilledPath).toBeNull();
	});

	// One pty read is 1 022 bytes on macOS; anything above it is two chunks, and the
	// fold-and-drop needs a second chunk to exist.
	it("sits at or under the measured pty read size", () => {
		expect(AGENT_MESSAGE_SPILL_THRESHOLD_BYTES).toBeLessThanOrEqual(1022);
	});
});
