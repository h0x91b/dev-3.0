import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { I18nProvider } from "../../i18n";
import { TaskRefText, splitTaskText } from "../TaskRefText";
import { CommentMarkdown, TaskDescriptionMarkdown } from "../pr-review/markdown";
import { parsePathLinkUrl, pathLinkUrl } from "../pr-review/markdown-task-text";
import { clearTextPathCache, pathLinkLabel } from "../../text-path-links";
import { OPEN_FILE_PREVIEW_EVENT } from "../../terminal-path-open";
import { installImmediateIntersectionObserver } from "../../test-utils/immediate-intersection";

const rpc = vi.hoisted(() => ({ electrobun: false }));
const resolveTerminalPaths = vi.fn();
vi.mock("../../rpc", () => ({
	api: { request: {
		resolveTerminalPaths: (...args: unknown[]) => resolveTerminalPaths(...args),
		getGlobalSettings: async () => ({ terminalPathOpenMode: "preview" }),
	} },
	get isElectrobun() { return rpc.electrobun; },
}));
vi.mock("../../toast", () => ({ toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() } }));
vi.mock("@streamdown/mermaid", () => ({
	createMermaidPlugin: () => ({ name: "mermaid", type: "diagram", language: "mermaid", getMermaid: () => ({ initialize: vi.fn(), render: vi.fn() }) }),
}));

installImmediateIntersectionObserver();

const ON_DISK: Record<string, { path: string; kind: "file" | "directory" }> = {
	"todo/brief.md": { path: "/repo/todo/brief.md", kind: "file" },
	"src/app.ts": { path: "/repo/src/app.ts", kind: "file" },
	"/home/me/notes/plan.md": { path: "/home/me/notes/plan.md", kind: "file" },
	"docs/api/": { path: "/repo/docs/api", kind: "directory" },
	"path:a1c9fe4e/todo/x.md": { path: "/other/todo/x.md", kind: "file" },
	"C:\\Users\\me\\plan.md": { path: "C:\\Users\\me\\plan.md", kind: "file" },
	"C:/Users/me/plan.md": { path: "C:\\Users\\me\\plan.md", kind: "file" },
	"src/__init__.py": { path: "/repo/src/__init__.py", kind: "file" },
};

const wrap = (node: React.ReactNode) => render(<I18nProvider>{node}</I18nProvider>);

beforeEach(() => {
	clearTextPathCache();
	rpc.electrobun = false;
	resolveTerminalPaths.mockReset();
	resolveTerminalPaths.mockImplementation(async ({ paths }: { paths: string[] }) => ({
		resolved: Object.fromEntries(paths.map((path) => [path, ON_DISK[path] ?? null])),
	}));
});

describe("splitTaskText", () => {
	it("cuts out refs first, then path candidates, and leaves URLs as prose", () => {
		const parts = splitTaskText("see seq:3, todo/brief.md and https://x.dev/a/b");
		expect(parts).toEqual([
			"see ",
			{ kind: "ref", ref: { kind: "task", number: 3 }, key: 4 },
			", ",
			{ kind: "path", raw: "todo/brief.md", path: "todo/brief.md", line: undefined, key: 11 },
			" and https://x.dev/a/b",
		]);
	});

	it("keeps a :line suffix in the text and strips it from the path", () => {
		const [, part] = splitTaskText("at src/app.ts:12.");
		expect(part).toEqual({ kind: "path", raw: "src/app.ts:12", path: "src/app.ts", line: 12, key: 3 });
	});

	it("reads a path token as one link labelled by its project path", () => {
		const parts = splitTaskText("brief path:a1c9fe4e/todo/x.md:4, see todo/brief.md");
		expect(parts[1]).toEqual({ kind: "path", raw: "path:a1c9fe4e/todo/x.md:4", path: "path:a1c9fe4e/todo/x.md", line: 4, key: 6, label: "todo/x.md:4" });
		expect(parts[3]).toMatchObject({ kind: "path", path: "todo/brief.md" });
	});

	it("finds no paths when path links are off", () => {
		expect(splitTaskText("todo/brief.md", false)).toEqual(["todo/brief.md"]);
	});
});

describe("pathLinkLabel", () => {
	it("shortens absolute and home paths to the file name and keeps relative ones", () => {
		expect(pathLinkLabel("/home/me/notes/plan.md")).toBe("plan.md");
		expect(pathLinkLabel("~/notes/plan.md:4")).toBe("plan.md:4");
		expect(pathLinkLabel("todo/brief.md")).toBe("todo/brief.md");
	});
});

describe("path link URLs", () => {
	it("carries a line as #L<n> and drops any other fragment", () => {
		expect(pathLinkUrl("a.ts", 12)).toBe("a.ts#L12");
		expect(parsePathLinkUrl("a.ts#L12")).toEqual({ path: "a.ts", line: 12 });
		expect(parsePathLinkUrl("docs/a.md#usage")).toEqual({ path: "docs/a.md" });
	});
});

describe("TaskRefText path links", () => {
	it("links only the paths that exist, in one RPC scoped to the task", async () => {
		wrap(<TaskRefText text="read todo/brief.md, not todo/missing.md" contextProjectId="p1" taskId="t1" />);
		await screen.findByRole("button", { name: /todo\/brief\.md/ });
		expect(screen.queryByRole("button", { name: /missing/ })).toBeNull();
		expect(resolveTerminalPaths).toHaveBeenCalledTimes(1);
		expect(resolveTerminalPaths).toHaveBeenCalledWith({ projectId: "p1", taskId: "t1", paths: ["todo/brief.md", "todo/missing.md"] });
	});

	it("opens the in-app preview at the written line", async () => {
		const opened = vi.fn();
		window.addEventListener(OPEN_FILE_PREVIEW_EVENT, opened as EventListener);
		wrap(<TaskRefText text="bug in src/app.ts:7" contextProjectId="p1" taskId="t1" />);
		fireEvent.click(await screen.findByRole("button", { name: /src\/app\.ts:7/ }));
		await waitFor(() => expect(opened).toHaveBeenCalled());
		expect((opened.mock.calls[0][0] as CustomEvent).detail).toEqual({ path: "/repo/src/app.ts", line: 7, taskId: "t1" });
		window.removeEventListener(OPEN_FILE_PREVIEW_EVENT, opened as EventListener);
	});

	it("shows an absolute path by its file name but copies the whole path", async () => {
		const { container } = wrap(<TaskRefText text="plan: /home/me/notes/plan.md" contextProjectId="p1" />);
		const chip = await screen.findByRole("button", { name: /\/home\/me\/notes\/plan\.md/ });
		expect(chip.querySelector('[aria-hidden="true"]')?.textContent).toBe("plan.md");
		expect(chip.querySelector(".sr-only")?.textContent).toBe("/home/me/notes/plan.md");
		expect(container.textContent).toContain("/home/me/notes/plan.md");
	});

	it("leaves a folder as text in the browser, where it cannot open", async () => {
		wrap(<TaskRefText text="see docs/api/" contextProjectId="p1" />);
		await waitFor(() => expect(resolveTerminalPaths).toHaveBeenCalled());
		expect(screen.queryByRole("button")).toBeNull();
	});

	it("links a folder in the desktop app", async () => {
		rpc.electrobun = true;
		wrap(<TaskRefText text="see docs/api/" contextProjectId="p1" />);
		await screen.findByRole("button", { name: /Open folder/ });
	});

	it("stays plain text when the backend cannot answer", async () => {
		resolveTerminalPaths.mockRejectedValue(new Error("offline"));
		wrap(<TaskRefText text="read todo/brief.md" contextProjectId="p1" />);
		await waitFor(() => expect(resolveTerminalPaths).toHaveBeenCalled());
		expect(screen.queryByRole("button")).toBeNull();
	});
});

describe("path tokens", () => {
	it("render as a chip showing the project path and copying the token", async () => {
		wrap(<TaskRefText text="brief: <path:a1c9fe4e/todo/x.md>" contextProjectId="p1" />);
		const chip = await screen.findByRole("button", { name: /\/other\/todo\/x\.md/ });
		expect(chip.querySelector('[aria-hidden="true"]')?.textContent).toBe("todo/x.md");
		expect(chip.querySelector(".sr-only")?.textContent).toBe("<path:a1c9fe4e/todo/x.md>");
	});

	it("survive the markdown sanitizer as autolinks, bare text and code spans", async () => {
		wrap(<TaskDescriptionMarkdown body={"A <path:a1c9fe4e/todo/x.md>. B path:a1c9fe4e/todo/x.md. C `path:a1c9fe4e/todo/x.md`."} projectId="p1" taskId="t1" />);
		await waitFor(() => expect(screen.getAllByRole("button", { name: /\/other\/todo\/x\.md/ })).toHaveLength(3));
		for (const chip of screen.getAllByRole("button", { name: /\/other\/todo\/x\.md/ })) {
			expect(chip.querySelector('[aria-hidden="true"]')?.textContent).toBe("todo/x.md");
		}
		expect(resolveTerminalPaths.mock.calls.flatMap(([arg]) => arg.paths)).toContain("path:a1c9fe4e/todo/x.md");
	});
});

describe("TaskDescriptionMarkdown path links", () => {
	it("links bare paths, whole-path code spans and relative markdown links", async () => {
		wrap(<TaskDescriptionMarkdown body={"Brief: todo/brief.md. Code: `src/app.ts:3`. [The plan](/home/me/notes/plan.md). Gone: `nope/x.md`."} projectId="p1" taskId="t1" />);
		const brief = await screen.findByRole("button", { name: /todo\/brief\.md/ });
		expect(brief.textContent).toBe("todo/brief.md");
		const code = await screen.findByRole("button", { name: /src\/app\.ts:3/ });
		expect(code.querySelector("code")?.textContent).toBe("src/app.ts:3");
		const plan = await screen.findByRole("button", { name: /plan\.md/ });
		expect(plan.textContent).toBe("The plan");
		expect(screen.getByText("nope/x.md").closest("button")).toBeNull();
		expect(resolveTerminalPaths.mock.calls.flatMap(([arg]) => arg.paths)).toEqual(
			expect.arrayContaining(["todo/brief.md", "src/app.ts", "/home/me/notes/plan.md", "nope/x.md"]),
		);
	});

	it("links Windows drive paths with either separator", async () => {
		wrap(<TaskDescriptionMarkdown body={"Plan: C:\\Users\\me\\plan.md or C:/Users/me/plan.md"} projectId="p1" taskId="t1" />);
		await waitFor(() => expect(screen.getAllByRole("button", { name: /plan\.md/ })).toHaveLength(2));
	});

	it("links a dunder file name that markdown would otherwise read as emphasis", async () => {
		wrap(<TaskDescriptionMarkdown body={"Edit src/__init__.py now"} projectId="p1" taskId="t1" />);
		await screen.findByRole("button", { name: /src\/__init__\.py/ });
	});

	it("labels a token by its real path, whatever text an author wrapped it in", async () => {
		wrap(<CommentMarkdown body={"[setup docs](path:a1c9fe4e/todo/x.md)"} />);
		const chip = await screen.findByRole("button", { name: /\/other\/todo\/x\.md/ });
		expect(chip.querySelector('[aria-hidden="true"]')?.textContent).toBe("todo/x.md");
	});

	it("leaves a fenced code block alone", async () => {
		wrap(<TaskDescriptionMarkdown body={"```\ncat todo/brief.md\n```"} projectId="p1" taskId="t1" />);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(screen.queryByRole("button", { name: /todo\/brief\.md/ })).toBeNull();
	});
});
