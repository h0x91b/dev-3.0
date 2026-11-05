import { describe, it, expect, vi } from "vitest";
import type { Project, Task } from "../../shared/types";

vi.mock("../data", () => ({
	getProject: vi.fn(),
	loadTasks: vi.fn(async () => []),
	addTask: vi.fn(),
	updateTask: vi.fn(),
	updateProjectWith: vi.fn(),
}));
vi.mock("../conversation-import", () => ({ scanImportableConversations: vi.fn() }));
vi.mock("../conversation-parse", () => ({ parseTranscriptFile: vi.fn(() => ({ turns: [] })) }));
vi.mock("../../shared/conversation-render", () => ({
	renderImportedDescription: vi.fn(() => "imported description"),
	firstUserRequest: vi.fn(() => "first request"),
}));
vi.mock("../rpc-handlers/shared", () => ({
	getPushMessage: vi.fn(() => null),
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import * as data from "../data";
import { scanImportableConversations } from "../conversation-import";
import { conversationImportHandlers } from "../rpc-handlers/conversation-import-handlers";

describe("conversation import origin", () => {
	it("records an imported task as an import, not as the user's", async () => {
		const project = { id: "proj-1", name: "P", path: "/tmp/p", kind: "git", labels: [] } as unknown as Project;
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.updateProjectWith).mockResolvedValue({ result: { id: "lbl", name: "imported", color: "#000" }, project } as never);
		vi.mocked(scanImportableConversations).mockReturnValue([{
			source: "claude", sessionId: "s1", title: "Old work", titledFromRequest: true, workingDir: "/tmp/p",
			lastActivityMs: 0, turns: 3, targetStatus: "completed", transcriptPath: "/tmp/s1.jsonl",
		}] as never);
		vi.mocked(data.addTask).mockResolvedValue({ id: "t1" } as Task);

		const result = await conversationImportHandlers.importConversations({ projectId: "proj-1", sessionIds: ["s1"] });

		expect(result.imported).toBe(1);
		expect(vi.mocked(data.addTask).mock.calls[0][3]).toEqual(
			expect.objectContaining({ importedSessionId: "s1", origin: { kind: "import" } }),
		);
	});
});
