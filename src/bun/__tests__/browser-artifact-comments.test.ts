import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Project, Task } from "../../shared/types";

let stored: Task;
vi.mock("../data", () => ({
	updateTaskWith: vi.fn(async (_project: Project, _taskId: string, mutate: (task: Task) => { updates: Partial<Task>; result: unknown }) => {
		const { updates, result } = mutate(stored);
		stored = { ...stored, ...updates };
		return { task: stored, result };
	}),
}));

import { addBrowserComment, browserPins, parseBrowserArtifactRef, parseBrowserCommentInput, resolveBrowserArtifact } from "../browser-artifact-comments";
import { LiveOpError } from "../live-artifact-ops";

const project = { id: "p1", path: "/tmp/p" } as Project;
const liveTarget = () => resolveBrowserArtifact(stored, { kind: "live" })!;
const input = { selector: "#plan > li", text: "Step two", heading: "Plan", body: "Split this step", send: true };

beforeEach(() => {
	stored = { id: "t1", status: "in-progress", liveArtifact: { page: { title: "Board" } } } as Task;
});

describe("browser tab comments", () => {
	it("stores the comment on the review anchored to the live entry, sends the review prompt and marks it sent", async () => {
		const sendToAgent = vi.fn(async () => undefined);
		const push = vi.fn();
		const result = await addBrowserComment(project, stored, liveTarget(), input, { sendToAgent, push });
		expect(result.sent).toBe(true);
		expect(stored.review).toHaveLength(1);
		expect(stored.review![0]).toMatchObject({
			body: "Split this step",
			anchor: { kind: "artifact-element", artifactId: "live:t1", version: 1, title: "Board", selector: "#plan > li", heading: "Plan" },
		});
		expect(stored.review![0].sentAt).toBeTruthy();
		expect(sendToAgent).toHaveBeenCalledWith(expect.objectContaining({ id: "t1" }), expect.stringContaining("<reviews>"));
		expect(push).toHaveBeenCalledWith("taskUpdated", expect.anything());
	});

	it("only saves when not asked to send", async () => {
		const sendToAgent = vi.fn(async () => undefined);
		await addBrowserComment(project, stored, liveTarget(), { ...input, send: false }, { sendToAgent, push: null });
		expect(sendToAgent).not.toHaveBeenCalled();
		expect(stored.review![0].sentAt).toBeUndefined();
	});

	it("keeps the comment when delivery fails and says so", async () => {
		const sendToAgent = vi.fn(async () => { throw new Error("no agent pane"); });
		await expect(addBrowserComment(project, stored, liveTarget(), input, { sendToAgent, push: null })).rejects.toThrow(/Saved, but not sent: no agent pane/);
		expect(stored.review).toHaveLength(1);
		expect(stored.review![0].sentAt).toBeUndefined();
	});

	it("refuses a finished task", async () => {
		stored = { ...stored, status: "completed" };
		await expect(addBrowserComment(project, stored, liveTarget(), input, { sendToAgent: vi.fn(), push: null })).rejects.toBeInstanceOf(LiveOpError);
		expect(stored.review).toBeUndefined();
	});

	it("anchors a static artifact comment to its group and version, and lists only that version's pins", async () => {
		stored = {
			...stored,
			sharedArtifacts: [{ id: "art", title: "Report", version: 3, previousVersions: [{ version: 2, name: "index.html", storedPath: "/v2", originalPath: "/o", bytes: 1, createdAt: 1, assets: [] }] }],
		} as unknown as Task;
		const v2 = resolveBrowserArtifact(stored, parseBrowserArtifactRef({ id: "art", version: 2 }))!;
		expect(v2.page.storedPath).toBe("/v2");
		await addBrowserComment(project, stored, v2, { ...input, send: false }, { sendToAgent: vi.fn(), push: null });
		expect(stored.review![0].anchor).toMatchObject({ artifactId: "art", version: 2, title: "Report" });
		expect(browserPins(stored, v2)).toHaveLength(1);
		expect(browserPins(stored, resolveBrowserArtifact(stored, { kind: "static", id: "art", version: 3 })!)).toEqual([]);
		expect(resolveBrowserArtifact(stored, { kind: "static", id: "art", version: 9 })).toBeNull();
		expect(resolveBrowserArtifact(stored, { kind: "static", id: "gone", version: 1 })).toBeNull();
		expect(() => parseBrowserArtifactRef({ id: "art", version: "2" })).toThrow(LiveOpError);
	});

	it("caps and validates what the page sends", () => {
		expect(() => parseBrowserCommentInput({ selector: "#a", body: "" })).toThrow(LiveOpError);
		const parsed = parseBrowserCommentInput({ selector: "#a", body: "x", text: "y".repeat(500), heading: "", send: "yes" });
		expect(parsed.text.length).toBe(200);
		expect(parsed.heading).toBeNull();
		expect(parsed.send).toBe(false);
	});
});
