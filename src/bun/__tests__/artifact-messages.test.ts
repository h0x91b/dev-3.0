import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../logger", () => ({
	createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const loadProjects = vi.fn();
const loadVirtualProjects = vi.fn();
const loadTasks = vi.fn();
vi.mock("../data", () => ({
	loadProjects: () => loadProjects(),
	loadVirtualProjects: () => loadVirtualProjects(),
	loadTasks: (...args: unknown[]) => loadTasks(...args),
}));

const sendMessageImmediately = vi.fn();
vi.mock("../scheduled-message-scheduler", () => ({
	sendMessageImmediately: (...args: unknown[]) => sendMessageImmediately(...args),
}));

vi.mock("../rpc-handlers/shared", () => ({
	log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { artifactMessageHandlers } from "../rpc-handlers/artifact-messages";

const otherProject = { id: "p0", path: "/tmp/other" };
const project = { id: "p1", path: "/tmp/proj" };
const task = { id: "t1", status: "in-progress" };

const params = {
	taskId: "t1",
	text: "Option B, and skip the legacy folder",
	artifactTitle: "Rollout plan",
	version: 3,
	versionCount: 7,
};

const ENVELOPE = [
	"<dev3-artifact-message>",
	"<artifact-title>Rollout plan</artifact-title>",
	"<artifact-version>3 of 7</artifact-version>",
	"<message>",
	"Option B, and skip the legacy folder",
	"</message>",
	"</dev3-artifact-message>",
].join("\n");

beforeEach(() => {
	vi.clearAllMocks();
	loadProjects.mockResolvedValue([otherProject, project]);
	loadVirtualProjects.mockResolvedValue([]);
	loadTasks.mockImplementation(async (p: { id: string }) => (p.id === project.id ? [task] : []));
	sendMessageImmediately.mockResolvedValue({ status: "delivered", spilledPath: null });
});

describe("sendArtifactMessageToAgent", () => {
	it("finds the owning task across projects and delivers the wrapped text", async () => {
		await artifactMessageHandlers.sendArtifactMessageToAgent(params);
		expect(sendMessageImmediately).toHaveBeenCalledWith(task, ENVELOPE, null, null, { hold: false });
	});

	// The user clicked inside the report and is watching the pane: a held message
	// types nothing at all, which is exactly what "the button did nothing" looks like.
	it("never holds the send", async () => {
		await artifactMessageHandlers.sendArtifactMessageToAgent(params);
		expect(sendMessageImmediately.mock.calls[0]?.[4]).toEqual({ hold: false });
	});

	// A completed or cancelled task is refused one layer down; the point here is that
	// the refusal reaches the caller instead of reading as a successful send.
	it("propagates a delivery refusal rather than reporting success", async () => {
		sendMessageImmediately.mockRejectedValue(new Error("Cannot send a message to a completed or cancelled task"));
		await expect(artifactMessageHandlers.sendArtifactMessageToAgent(params))
			.rejects.toThrow(/completed or cancelled/);
	});

	it("propagates a dead agent session as an error", async () => {
		sendMessageImmediately.mockRejectedValue(new Error("no live agent session"));
		await expect(artifactMessageHandlers.sendArtifactMessageToAgent(params)).rejects.toThrow(/no live agent/);
	});

	it("fails loudly when no board owns the task", async () => {
		loadTasks.mockResolvedValue([]);
		await expect(artifactMessageHandlers.sendArtifactMessageToAgent(params)).rejects.toThrow(/Could not find the task/);
		expect(sendMessageImmediately).not.toHaveBeenCalled();
	});

	it("reports the file an oversized submission was spilled to", async () => {
		sendMessageImmediately.mockResolvedValue({ status: "delivered", spilledPath: "/tmp/wt/messages/message-x.md" });
		await expect(artifactMessageHandlers.sendArtifactMessageToAgent(params))
			.resolves.toEqual({ spilledPath: "/tmp/wt/messages/message-x.md" });
	});
});
