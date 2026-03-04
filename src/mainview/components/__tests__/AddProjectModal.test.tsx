import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import AddProjectModal from "../AddProjectModal";
import { I18nProvider } from "../../i18n";
import type { AppAction } from "../../state";

vi.mock("../../rpc", () => ({
	api: {
		request: {
			pickFolder: vi.fn(),
			addProject: vi.fn(),
			cloneAndAddProject: vi.fn(),
			getGlobalSettings: vi.fn(() =>
				Promise.resolve({
					defaultAgentId: "builtin-claude",
					defaultConfigId: "claude-default",
					taskDropPosition: "top",
					updateChannel: "stable",
				}),
			),
			saveGlobalSettings: vi.fn(),
		},
	},
}));

import { api } from "../../rpc";

const mockedApi = vi.mocked(api, true);

function renderModal(
	dispatch?: React.Dispatch<AppAction>,
	onClose?: () => void,
) {
	return render(
		<I18nProvider>
			<AddProjectModal
				dispatch={dispatch ?? vi.fn()}
				onClose={onClose ?? vi.fn()}
			/>
		</I18nProvider>,
	);
}

const mockProject = {
	id: "p-new",
	name: "my-repo",
	path: "/base/my-repo",
	setupScript: "",
	devScript: "",
	cleanupScript: "",
	defaultBaseBranch: "main",
	createdAt: "2025-01-01T00:00:00Z",
};

describe("AddProjectModal", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("renders with two tabs", () => {
		renderModal();
		expect(screen.getByText("Local Folder")).toBeInTheDocument();
		expect(screen.getByText("Clone from URL")).toBeInTheDocument();
	});

	it("defaults to Local Folder tab with Browse button", () => {
		renderModal();
		expect(screen.getByText("Browse...")).toBeInTheDocument();
	});

	it("switches to Clone tab and shows URL input", async () => {
		const user = userEvent.setup();
		renderModal();
		await user.click(screen.getByText("Clone from URL"));
		expect(screen.getByPlaceholderText("https://github.com/user/repo.git")).toBeInTheDocument();
	});

	it("calls pickFolder and addProject from Local tab", async () => {
		const user = userEvent.setup();
		const dispatch = vi.fn();
		const onClose = vi.fn();

		mockedApi.request.pickFolder.mockResolvedValue("/new/path");
		mockedApi.request.addProject.mockResolvedValue({
			ok: true as const,
			project: { ...mockProject, path: "/new/path", name: "path" },
		});

		renderModal(dispatch, onClose);
		await user.click(screen.getByText("Browse..."));

		expect(mockedApi.request.pickFolder).toHaveBeenCalled();
		expect(mockedApi.request.addProject).toHaveBeenCalledWith({
			path: "/new/path",
			name: "path",
		});
		expect(dispatch).toHaveBeenCalledWith({
			type: "addProject",
			project: expect.objectContaining({ path: "/new/path" }),
		});
		expect(onClose).toHaveBeenCalled();
	});

	it("does nothing when pickFolder returns null", async () => {
		const user = userEvent.setup();
		const dispatch = vi.fn();

		mockedApi.request.pickFolder.mockResolvedValue(null);

		renderModal(dispatch);
		await user.click(screen.getByText("Browse..."));

		expect(mockedApi.request.addProject).not.toHaveBeenCalled();
		expect(dispatch).not.toHaveBeenCalled();
	});

	it("Clone button is disabled when URL is empty", async () => {
		const user = userEvent.setup();
		renderModal();
		await user.click(screen.getByText("Clone from URL"));

		const cloneBtn = screen.getByText("Clone");
		expect(cloneBtn).toBeDisabled();
	});

	it("calls cloneAndAddProject on Clone tab submit", async () => {
		const user = userEvent.setup();
		const dispatch = vi.fn();
		const onClose = vi.fn();

		// Return settings with a saved base directory
		mockedApi.request.getGlobalSettings.mockResolvedValue({
			defaultAgentId: "builtin-claude",
			defaultConfigId: "claude-default",
			taskDropPosition: "top",
			updateChannel: "stable",
			cloneBaseDirectory: "/base",
		});

		mockedApi.request.cloneAndAddProject.mockResolvedValue({
			ok: true as const,
			project: mockProject,
		});

		renderModal(dispatch, onClose);
		await user.click(screen.getByText("Clone from URL"));

		const urlInput = screen.getByPlaceholderText("https://github.com/user/repo.git");
		await user.type(urlInput, "https://github.com/user/my-repo.git");
		await user.click(screen.getByText("Clone"));

		expect(mockedApi.request.cloneAndAddProject).toHaveBeenCalledWith({
			url: "https://github.com/user/my-repo.git",
			baseDir: "/base",
			repoName: undefined,
		});
		expect(dispatch).toHaveBeenCalledWith({
			type: "addProject",
			project: expect.objectContaining({ id: "p-new" }),
		});
		expect(onClose).toHaveBeenCalled();
	});

	it("shows error when clone fails", async () => {
		const user = userEvent.setup();

		mockedApi.request.getGlobalSettings.mockResolvedValue({
			defaultAgentId: "builtin-claude",
			defaultConfigId: "claude-default",
			taskDropPosition: "top",
			updateChannel: "stable",
			cloneBaseDirectory: "/base",
		});

		mockedApi.request.cloneAndAddProject.mockResolvedValue({
			ok: false as const,
			error: "fatal: repo not found",
		});

		renderModal();
		await user.click(screen.getByText("Clone from URL"));
		await user.type(
			screen.getByPlaceholderText("https://github.com/user/repo.git"),
			"https://github.com/bad/url.git",
		);
		await user.click(screen.getByText("Clone"));

		expect(screen.getByText("fatal: repo not found")).toBeInTheDocument();
	});

	it("calls onClose when Cancel is clicked", async () => {
		const user = userEvent.setup();
		const onClose = vi.fn();

		renderModal(vi.fn(), onClose);
		await user.click(screen.getByText("Cancel"));

		expect(onClose).toHaveBeenCalled();
	});
});
