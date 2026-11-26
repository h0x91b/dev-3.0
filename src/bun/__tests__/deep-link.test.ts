import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Project, Task } from "../../shared/types";
import {
	parseDeepLink,
	buildTaskDeepLink,
	buildProjectDeepLink,
	buildNewTaskDeepLink,
	buildTaskWebLink,
	buildTaskPrDeepLinkLine,
	buildTaskPrDeepLinkSection,
	deepLinkSchemeRegistered,
	buildSpaceDeepLink,
	buildSpaceWebLink,
	DEEP_LINK_WEB_BASE,
	findDeepLinksInText,
} from "../../shared/deep-link";

vi.mock("../spaces-data", () => ({
	loadSpacesFile: vi.fn(() => Promise.resolve({ version: 1, spaces: [], order: [] })),
}));

vi.mock("../data", () => ({
	loadProjects: vi.fn(),
	loadVirtualProjects: vi.fn(() => Promise.resolve([])),
	loadTasks: vi.fn(),
}));

import * as data from "../data";
import * as spacesData from "../spaces-data";
import { resolveDeepLink } from "../deep-link";
import {
	markPendingDeepLinkNav,
	consumePendingDeepLinkNav,
	__resetPendingDeepLinkNavForTests,
} from "../deep-link-nav";

const project = (id: string): Project => ({ id } as Project);
const task = (id: string, status: Task["status"] = "in-progress", extra: Partial<Task> = {}): Task =>
	({ id, status, ...extra } as Task);

describe("parseDeepLink", () => {
	it("parses task, project and new-task links (host case-insensitive, trailing slash tolerated), rejects the rest", () => {
		expect(parseDeepLink("dev3://task/abc-123")).toEqual({ kind: "task", taskId: "abc-123" });
		expect(parseDeepLink("dev3://project/p1/")).toEqual({ kind: "project", projectId: "p1" });
		expect(parseDeepLink("dev3://TASK/AbC")).toEqual({ kind: "task", taskId: "AbC" });
		expect(parseDeepLink("dev3://new-task?project=p1&text=hello%20world")).toEqual({ kind: "new-task", projectId: "p1", text: "hello world" });
		expect(parseDeepLink("dev3://new-task")).toEqual({ kind: "new-task", projectId: undefined, text: undefined });
		// Rejects the wrong scheme, an unknown host, a missing id and a non-URL.
		for (const raw of ["https://task/abc", "dev3://bogus/abc", "dev3://task/", "not a url"]) {
			expect(parseDeepLink(raw), raw).toBeNull();
		}
	});
});

describe("build* + round-trip", () => {
	it("builds and re-parses task, project, space and new-task links, escaping ids and text", () => {
		expect(parseDeepLink(buildTaskDeepLink("a/b c"))).toEqual({ kind: "task", taskId: "a/b c" });
		expect(parseDeepLink(buildProjectDeepLink("p1"))).toEqual({ kind: "project", projectId: "p1" });
		expect(parseDeepLink(buildSpaceDeepLink("sp 1/x"))).toEqual({ kind: "space", spaceId: "sp 1/x" });
		expect(buildSpaceWebLink("sp_1")).toBe(`${DEEP_LINK_WEB_BASE}/open.html?space=sp_1`);
		expect(buildTaskWebLink("a/b c")).toBe(`${DEEP_LINK_WEB_BASE}/open.html?task=a%2Fb%20c`);
		// New-task text with special characters round-trips; absent params are omitted.
		const text = "fix: café & <naïve> \"quotes\"\nnewline 日本語";
		expect(parseDeepLink(buildNewTaskDeepLink({ projectId: "p1", text }))).toEqual({ kind: "new-task", projectId: "p1", text });
		expect(buildNewTaskDeepLink()).toBe("dev3://new-task");
	});
});

describe("buildTaskPrDeepLinkLine", () => {
	// It rides inside the handoff prompt, which is typed into the pane byte for byte:
	// one newline could submit the prompt early on a non-Claude agent.
	it("line and section carry both links and the opt-out; the line has no newline", () => {
		const line = buildTaskPrDeepLinkLine("abc-123");
		expect(line).toContain(buildTaskWebLink("abc-123"));
		expect(line).toContain("`dev3://task/abc-123`");
		expect(line).toContain("Settings → Tasks");
		expect(line).not.toContain("\n");

		// The section carries both links, the opt-out, and a blank line before the rule so it cannot make a heading.
		const section = buildTaskPrDeepLinkSection("t1");
		expect(section).toContain(buildTaskWebLink("t1"));
		expect(section).toContain("`dev3://task/t1`");
		expect(section).toContain("Settings → Tasks");
		expect(section.startsWith("\n\n---")).toBe(true);
		expect(section).not.toMatch(/[^\n]\n---/);
	});
});

describe("resolveDeepLink", () => {
	beforeEach(() => {
		vi.mocked(data.loadProjects).mockResolvedValue([project("p1"), project("p2")]);
		vi.mocked(data.loadVirtualProjects).mockResolvedValue([project("ops")]);
		vi.mocked(data.loadTasks).mockImplementation(async (p: Project) =>
			p.id === "p2" ? [task("t-in-p2")] : [],
		);
	});

	it("resolves a task to its owning project, and an unknown task to null", async () => {
		expect(await resolveDeepLink({ kind: "task", taskId: "t-in-p2" })).toEqual({
			kind: "task",
			taskId: "t-in-p2",
			projectId: "p2",
		});
		expect(await resolveDeepLink({ kind: "task", taskId: "ghost" })).toBeNull();
	});

	it("flags a task with no terminal (To Do, completed, cancelled) to open as its board card (#2347)", async () => {
		vi.mocked(data.loadTasks).mockResolvedValue([task("t-todo", "todo"), task("t-done", "completed"), task("t-gone", "cancelled")]);
		for (const taskId of ["t-todo", "t-done", "t-gone"]) {
			expect(await resolveDeepLink({ kind: "task", taskId })).toEqual({ kind: "task", taskId, projectId: "p1", archived: true });
		}
	});

	it("keeps a hibernated task in an active column on its task view, where the wake screen is", async () => {
		vi.mocked(data.loadTasks).mockResolvedValue([task("t-zz", "in-progress", { hibernated: true })]);
		expect(await resolveDeepLink({ kind: "task", taskId: "t-zz" })).toEqual({ kind: "task", taskId: "t-zz", projectId: "p1" });
	});

	it("resolves an existing project (including virtual), and an unknown one to null", async () => {
		expect(await resolveDeepLink({ kind: "project", projectId: "ops" })).toEqual({
			kind: "project",
			projectId: "ops",
		});
		expect(await resolveDeepLink({ kind: "project", projectId: "nope" })).toBeNull();
	});

	it("resolves a space to its first member project that exists here, else null", async () => {
		vi.mocked(spacesData.loadSpacesFile).mockResolvedValue({
			version: 1,
			spaces: [{ id: "sp_1", name: "Client X", parentId: null, projectIds: ["ghost", "p2"], createdAt: 1 }],
			order: ["sp_1"],
		});
		expect(await resolveDeepLink({ kind: "space", spaceId: "sp_1" })).toEqual({
			kind: "space",
			spaceId: "sp_1",
			projectId: "p2",
		});
		// Null for a deleted space, one whose members are all gone, and an unknown one.
		vi.mocked(spacesData.loadSpacesFile).mockResolvedValue({
			version: 1,
			spaces: [
				{ id: "sp_dead", name: "Gone", parentId: null, projectIds: ["p1"], createdAt: 1, deleted: true },
				{ id: "sp_empty", name: "Empty", parentId: null, projectIds: ["ghost"], createdAt: 1 },
			],
			order: [],
		});
		expect(await resolveDeepLink({ kind: "space", spaceId: "sp_dead" })).toBeNull();
		expect(await resolveDeepLink({ kind: "space", spaceId: "sp_empty" })).toBeNull();
		expect(await resolveDeepLink({ kind: "space", spaceId: "sp_never" })).toBeNull();
	});

	it("new-task keeps a valid project, falls back to the first one, and is null with no projects", async () => {
		expect(await resolveDeepLink({ kind: "new-task", projectId: "p2", text: "hi" })).toEqual({
			kind: "new-task",
			projectId: "p2",
			text: "hi",
		});
		expect(await resolveDeepLink({ kind: "new-task" })).toEqual({
			kind: "new-task",
			projectId: "p1",
			text: "",
		});
		const nav = await resolveDeepLink({ kind: "new-task", projectId: "gone", text: "x" });
		expect(nav).toEqual({ kind: "new-task", projectId: "p1", text: "x" });
		vi.mocked(data.loadProjects).mockResolvedValue([]);
		vi.mocked(data.loadVirtualProjects).mockResolvedValue([]);
		expect(await resolveDeepLink({ kind: "new-task", text: "x" })).toBeNull();
	});
});

describe("pending deep-link nav slot", () => {
	beforeEach(() => __resetPendingDeepLinkNavForTests());

	it("read-and-clears the stored target", () => {
		markPendingDeepLinkNav({ kind: "project", projectId: "p1" });
		expect(consumePendingDeepLinkNav()).toEqual({ kind: "project", projectId: "p1" });
		expect(consumePendingDeepLinkNav()).toBeNull();
	});
});

// Only the macOS bundle registers the scheme; a link is inert everywhere else,
// which is what gates the PR footer and the injected skill's instruction.
describe("deepLinkSchemeRegistered", () => {
	it("is true on macOS and false on every other platform", () => {
		expect(deepLinkSchemeRegistered("darwin")).toBe(true);
		expect(deepLinkSchemeRegistered("win32")).toBe(false);
		expect(deepLinkSchemeRegistered("linux")).toBe(false);
	});
});

describe("findDeepLinksInText", () => {
	it("finds a task link printed in a line of prose, with its exact bounds", () => {
		const text = "see dev3://task/a21540d6-4890-426f-81c1-41cfc460715e for the report";
		const [match, ...rest] = findDeepLinksInText(text);
		expect(rest).toEqual([]);
		expect(match!.raw).toBe("dev3://task/a21540d6-4890-426f-81c1-41cfc460715e");
		expect(text.slice(match!.start, match!.end + 1)).toBe(match!.raw);
		expect(match!.target).toEqual({ kind: "task", taskId: "a21540d6-4890-426f-81c1-41cfc460715e" });
		// Ignores an unknown kind, an empty id and any other scheme.
		expect(findDeepLinksInText("dev3://bogus/x dev3://task/ http://example.com javascript:alert(1)")).toEqual([]);
	});

	it("drops trailing prose punctuation but keeps a query string, and finds every link on the line", () => {
		expect(findDeepLinksInText("dev3://task/t1 and dev3://space/s2").map((m) => m.raw)).toEqual([
			"dev3://task/t1",
			"dev3://space/s2",
		]);
		expect(findDeepLinksInText("open dev3://project/p1.").map((m) => m.raw)).toEqual(["dev3://project/p1"]);
		const [newTask] = findDeepLinksInText("(dev3://new-task?project=p1&text=hello%20world)");
		expect(newTask!.raw).toBe("dev3://new-task?project=p1&text=hello%20world");
		expect(newTask!.target).toEqual({ kind: "new-task", projectId: "p1", text: "hello world" });
	});

});
