import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExplorerEntry, ExplorerListing, Project, ProjectFolder } from "../../../shared/types";
import { I18nProvider } from "../../i18n";

vi.mock("../../rpc", () => ({
	isElectrobun: false,
	api: {
		request: {
			listExplorerDirectory: vi.fn(),
			getProjectFolders: vi.fn(),
			openTerminalPath: vi.fn(),
		},
	},
}));

import { api } from "../../rpc";
import FileExplorer from "../FileExplorer";
import { ProjectFoldersRows, ProjectFoldersToggle } from "../DashboardProjectFolders";

const mockedApi = vi.mocked(api, true);

function folder(path: string, over: Partial<ProjectFolder> = {}): ProjectFolder {
	const name = path.split("/").pop()!;
	return { path, displayPath: path, name, source: "claude", exists: true, ...over };
}

function entry(root: string, relPath: string, kind: ExplorerEntry["kind"]): ExplorerEntry {
	return { name: relPath.split("/").pop()!, path: `${root}/${relPath}`, relPath, kind, ignored: false };
}

const FOLDERS = [folder("/src/lib"), folder("/src/docs", { source: "dev3" })];
const TREES: Record<string, ExplorerEntry[]> = {
	"/wt": [entry("/wt", "README.md", "file")],
	"/src/lib": [entry("/src/lib", "index.ts", "file")],
	"/src/docs": [entry("/src/docs", "guide.md", "file")],
};

beforeEach(() => {
	vi.clearAllMocks();
	localStorage.clear();
	mockedApi.request.getProjectFolders.mockResolvedValue(FOLDERS);
	mockedApi.request.listExplorerDirectory.mockImplementation(async ({ folder: root }: { folder?: string | null }) => {
		const key = root ?? "/wt";
		return { root: key, relPath: "", entries: TREES[key] ?? [] } satisfies ExplorerListing;
	});
});

function renderExplorer(projectId: string) {
	return render(
		<I18nProvider>
			<FileExplorer projectId={projectId} taskId="task-1" rootLabel="feat/branch" rootSectionLabel="feat/branch" pinned onTogglePin={() => {}} onHide={() => {}} />
		</I18nProvider>,
	);
}

describe("FileExplorer with extra folders", () => {
	it("shows one section per folder, the worktree open and the extra folders collapsed", async () => {
		renderExplorer("multi-1");
		const picker = await screen.findByTestId("file-explorer-folders");
		expect(picker.textContent).toContain("3/3");
		expect(await screen.findByRole("treeitem", { name: /README\.md/ })).toBeTruthy();
		const lib = screen.getByRole("treeitem", { name: /^lib/ });
		expect(lib.getAttribute("aria-expanded")).toBe("false");
		expect(screen.queryByRole("treeitem", { name: /index\.ts/ })).toBeNull();

		await userEvent.click(lib);
		expect(await screen.findByRole("treeitem", { name: /index\.ts/ })).toBeTruthy();
		expect(mockedApi.request.listExplorerDirectory).toHaveBeenCalledWith(expect.objectContaining({ folder: "/src/lib", relPath: "" }));
	});

	it("hides a folder from the picker and names it under the tree", async () => {
		renderExplorer("multi-2");
		await userEvent.click(await screen.findByTestId("file-explorer-folders"));
		const menu = screen.getByTestId("file-explorer-folder-picker");
		await userEvent.click(within(menu).getByRole("menuitemcheckbox", { name: /docs/ }));
		await waitFor(() => expect(screen.getByTestId("file-explorer-folders").textContent).toContain("2/3"));
		expect(screen.queryByRole("treeitem", { name: /^docs/ })).toBeNull();
		expect(screen.getByTestId("file-explorer-hidden-folders").textContent).toContain("docs");
	});

	it("scrolls the row the arrow keys land on into view", async () => {
		const scroll = vi.fn();
		Element.prototype.scrollIntoView = scroll;
		renderExplorer("multi-3");
		await screen.findByRole("treeitem", { name: /README\.md/ });
		const tree = screen.getByRole("tree");
		tree.focus();
		await userEvent.keyboard("{ArrowDown}{ArrowDown}");
		expect(scroll).toHaveBeenCalled();
		const target = scroll.mock.contexts[scroll.mock.contexts.length - 1] as HTMLElement;
		expect(target.getAttribute("aria-selected")).toBe("true");
	});

	it("keeps keyboard focus on the toggled folder in the picker", async () => {
		renderExplorer("multi-4");
		await userEvent.click(await screen.findByTestId("file-explorer-folders"));
		const docs = within(screen.getByTestId("file-explorer-folder-picker")).getByRole("menuitemcheckbox", { name: /docs/ });
		docs.focus();
		await userEvent.keyboard(" ");
		await waitFor(() => expect(screen.getByTestId("file-explorer-folders").textContent).toContain("2/3"));
		expect(document.activeElement).toBe(docs);
	});

	it("draws neither header layout until the folder list answers", async () => {
		let answer!: (folders: ProjectFolder[]) => void;
		mockedApi.request.getProjectFolders.mockReturnValue(new Promise((resolve) => { answer = resolve; }));
		renderExplorer("pending-1");
		await waitFor(() => expect(mockedApi.request.getProjectFolders).toHaveBeenCalled());
		expect(screen.queryByText("feat/branch")).toBeNull();
		expect(screen.queryByTestId("file-explorer-folders")).toBeNull();
		answer(FOLDERS);
		expect((await screen.findByTestId("file-explorer-folders")).textContent).toContain("3/3");
	});

	it("falls back to the single-root header when the folder list fails", async () => {
		mockedApi.request.getProjectFolders.mockRejectedValue(new Error("offline"));
		renderExplorer("failed-1");
		expect(await screen.findByText("feat/branch")).toBeTruthy();
		expect(screen.queryByTestId("file-explorer-folders")).toBeNull();
	});

	it("keeps the single-root header when the project has no extra folders", async () => {
		mockedApi.request.getProjectFolders.mockResolvedValue([]);
		renderExplorer("single-1");
		expect(await screen.findByRole("treeitem", { name: /README\.md/ })).toBeTruthy();
		expect(screen.queryByTestId("file-explorer-folders")).toBeNull();
		expect(screen.getByText("feat/branch")).toBeTruthy();
	});
});

describe("dashboard project folders", () => {
	const project = { id: "dash-1", name: "p", path: "/p", kind: "git" } as Project;

	it("starts collapsed and expands into at most three rows plus 'Show N more'", async () => {
		mockedApi.request.getProjectFolders.mockResolvedValue(["/a/one", "/a/two", "/a/three", "/a/four", "/a/five"].map((p) => folder(p)));
		render(
			<I18nProvider>
				<ProjectFoldersToggle project={project} />
				<ProjectFoldersRows project={project} navigate={() => {}} />
			</I18nProvider>,
		);
		const toggle = await screen.findByTestId("project-folders-toggle-dash-1");
		expect(toggle.textContent).toContain("+5 folders");
		expect(screen.queryByTestId("project-folders-dash-1")).toBeNull();

		await userEvent.click(toggle);
		const rows = await screen.findByTestId("project-folders-dash-1");
		await waitFor(() => expect(within(rows).getAllByRole("button", { name: /^(one|two|three|four|five)/ })).toHaveLength(3));
		await userEvent.click(within(rows).getByRole("button", { name: "Show 2 more" }));
		expect(within(rows).getAllByRole("button", { name: /^(one|two|three|four|five)/ })).toHaveLength(5);
	});

	it("renders nothing for a project without extra folders", async () => {
		mockedApi.request.getProjectFolders.mockResolvedValue([]);
		const { container } = render(
			<I18nProvider>
				<ProjectFoldersToggle project={{ ...project, id: "dash-2" }} />
			</I18nProvider>,
		);
		await waitFor(() => expect(mockedApi.request.getProjectFolders).toHaveBeenCalled());
		expect(container.textContent).toBe("");
	});
});
