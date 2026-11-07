import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Project, Task } from "../../shared/types";

vi.mock("../data", () => ({
	loadProjects: vi.fn(),
	loadVirtualProjects: vi.fn(() => Promise.resolve([])),
	loadTasks: vi.fn(),
}));
vi.mock("../github-pr-status", () => ({ readTaskPullRequest: vi.fn() }));

import * as data from "../data";
import { readTaskPullRequest } from "../github-pr-status";
import { previewTaskPrRef, resolveTaskPrRef } from "../task-pr-refs";

const DEV3 = { id: "a1c9fe4e-0000", name: "dev-3.0", path: "/repo/dev3" } as Project;
const BREW = { id: "271edc14-0000", name: "homebrew-dev3", path: "/repo/brew" } as Project;
const task = (fields: Partial<Task>): Task => ({ title: "t", status: "todo", variantIndex: null, ...fields } as Task);

const boards: Record<string, Task[]> = {
	[DEV3.id]: [
		task({ id: "d-115", seq: 115, title: "Fix auth" }),
		task({ id: "d-200b", seq: 200, variantIndex: 2 }),
		task({ id: "d-200a", seq: 200, variantIndex: 1 }),
		task({
			id: "d-pr", seq: 300, prNumber: 2187, prUrl: "https://github.com/h0x91b/dev-3.0/pull/2187",
			prStatusCache: { number: 2187, url: "https://github.com/h0x91b/dev-3.0/pull/2187", ciStatus: "success", prTitle: "Cached", headRefName: "feat/x", cachedAt: "2026-11-05" } as Task["prStatusCache"],
		}),
		task({
			id: "d-rich", seq: 400, title: "Rich",
			notes: [1, 2, 3].map((i) => ({ id: `n${i}`, content: i === 3 ? "x".repeat(400) : `note ${i}`, source: "ai", createdAt: `2026-11-0${i}`, updatedAt: "" })),
			sharedImages: [1, 2, 3, 4].map((i) => ({ id: `i${i}`, storedPath: `/s/${i}.png`, originalPath: "", name: `${i}.png`, mime: "image/png", bytes: 1, createdAt: i })),
			sharedArtifacts: [{ id: "a1", title: "Report", kind: "html", name: "", storedPath: "", originalPath: "", bytes: 1, createdAt: 1, assets: [] }],
		} as Partial<Task>),
	],
	[BREW.id]: [task({ id: "b-115", seq: 115, title: "Bump cask" })],
};

beforeEach(() => {
	vi.mocked(data.loadProjects).mockResolvedValue([DEV3, BREW]);
	vi.mocked(data.loadTasks).mockImplementation(async (p: Project) => boards[p.id] ?? []);
	vi.mocked(readTaskPullRequest).mockReset();
});

describe("resolveTaskPrRef", () => {
	it("resolves a bare task ref on the context project", async () => {
		expect(await resolveTaskPrRef("<seq:115>", BREW.id)).toMatchObject({ kind: "task", taskId: "b-115", projectId: BREW.id, title: "Bump cask" });
		expect(await resolveTaskPrRef("seq:115", DEV3.id)).toMatchObject({ taskId: "d-115", projectName: "dev-3.0" });
	});

	it("follows a project qualifier — id prefix or name — over the context", async () => {
		expect(await resolveTaskPrRef("<seq:271edc14/115>", DEV3.id)).toMatchObject({ taskId: "b-115" });
		expect(await resolveTaskPrRef("<seq:homebrew-dev3/115>", DEV3.id)).toMatchObject({ taskId: "b-115" });
	});

	it("picks the first member of a variant group", async () => {
		expect(await resolveTaskPrRef("<seq:200>", DEV3.id)).toMatchObject({ taskId: "d-200a" });
	});

	it("returns null for no context, an unknown project or a missing seq", async () => {
		expect(await resolveTaskPrRef("<seq:115>")).toBeNull();
		expect(await resolveTaskPrRef("<seq:ffffffff/115>", DEV3.id)).toBeNull();
		expect(await resolveTaskPrRef("<seq:999>", DEV3.id)).toBeNull();
		expect(await resolveTaskPrRef("#115", DEV3.id)).toBeNull();
	});

	it("finds a PR's URL and owner on the board without asking GitHub", async () => {
		expect(await resolveTaskPrRef("<pr:2187>", DEV3.id)).toEqual({
			kind: "pr", number: 2187, projectId: DEV3.id, projectName: "dev-3.0",
			url: "https://github.com/h0x91b/dev-3.0/pull/2187", taskId: "d-pr",
		});
		expect(await resolveTaskPrRef("<pr:42>", DEV3.id)).toMatchObject({ url: "https://github.com/h0x91b/dev-3.0/pull/42" });
		expect(readTaskPullRequest).not.toHaveBeenCalled();
	});

	it("asks GitHub only when the board knows no PR of the repo", async () => {
		vi.mocked(readTaskPullRequest).mockResolvedValue({ pr: { url: "https://github.com/h0x91b/homebrew-dev3/pull/5" } } as never);
		expect(await resolveTaskPrRef("<pr:5>", BREW.id)).toMatchObject({ url: "https://github.com/h0x91b/homebrew-dev3/pull/5" });
		expect(readTaskPullRequest).toHaveBeenCalledWith(BREW, BREW.path, "", 5, undefined);
	});
});

describe("previewTaskPrRef", () => {
	it("carries the last notes (clipped), the newest images first and the artifacts", async () => {
		const preview = await previewTaskPrRef("<seq:400>", DEV3.id);
		if (preview?.kind !== "task") throw new Error("expected a task preview");
		expect(preview.notes.map((n) => n.id)).toEqual(["n2", "n3"]);
		expect(preview.notes[1].content.length).toBeLessThanOrEqual(280);
		expect(preview.images.map((i) => i.id)).toEqual(["i4", "i3", "i2"]);
		expect(preview.imageCount).toBe(4);
		expect(preview.artifacts.map((a) => a.title)).toEqual(["Report"]);
	});

	it("serves a PR from its owner's polled cache, and from GitHub when asked fresh", async () => {
		const cached = await previewTaskPrRef("<pr:2187>", DEV3.id);
		expect(cached).toMatchObject({ kind: "pr", badge: { number: 2187, ciStatus: "success", prTitle: "Cached" } });
		expect(cached?.kind === "pr" && cached.badge).not.toHaveProperty("cachedAt");
		expect(readTaskPullRequest).not.toHaveBeenCalled();

		vi.mocked(readTaskPullRequest).mockResolvedValue({
			pr: { number: 2187, url: "https://github.com/h0x91b/dev-3.0/pull/2187", title: "Live", state: "merged", mergeable: "unknown", mergeStateStatus: "clean", isDraft: false, autoMergeRequest: null, reviewDecision: null, statusCheckRollup: null, unresolvedCount: 0 },
		} as never);
		const fresh = await previewTaskPrRef("<pr:2187>", DEV3.id, true);
		expect(fresh).toMatchObject({ badge: { prTitle: "Live", mergeState: { state: "MERGED" } } });
		expect(readTaskPullRequest).toHaveBeenCalledWith(DEV3, DEV3.path, "", 2187, { force: true });
	});

	it("returns null for a reference that does not resolve", async () => {
		expect(await previewTaskPrRef("<seq:999>", DEV3.id)).toBeNull();
	});
});
