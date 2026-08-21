import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nProvider } from "../../i18n";
import ProjectSpacesField from "../ProjectSpacesField";
import type { SpacesFile } from "../../../shared/types";

const file: SpacesFile = {
	version: 1,
	spaces: [
		{ id: "sp_a", name: "Alpha", parentId: null, projectIds: ["p1"], createdAt: 1 },
		{ id: "sp_b", name: "Beta", parentId: null, projectIds: ["p2"], createdAt: 1 },
	],
	order: ["sp_a", "sp_b"],
};

vi.mock("../../rpc", () => ({
	api: {
		request: {
			getSpaces: vi.fn(() => Promise.resolve(file)),
			setProjectSpaces: vi.fn(() => Promise.resolve({ file, autoDeleted: [] })),
			createSpace: vi.fn(() =>
				Promise.resolve({ id: "sp_new", name: "New", parentId: null, projectIds: ["p1"], createdAt: 2 }),
			),
		},
	},
}));

const toastMock = vi.hoisted(() => ({ info: vi.fn(), error: vi.fn(), success: vi.fn() }));
vi.mock("../../toast", () => ({ toast: toastMock }));

beforeEach(() => {
	vi.clearAllMocks();
});

describe("ProjectSpacesField — connected mode", () => {
	it("renders the project's memberships as chips", async () => {
		render(
			<I18nProvider>
				<ProjectSpacesField projectId="p1" />
			</I18nProvider>,
		);
		await waitFor(() => expect(screen.getByTestId("space-chip-sp_a")).toHaveTextContent("Alpha"));
		expect(screen.queryByTestId("space-chip-sp_b")).not.toBeInTheDocument();
	});

	it("persists a toggle through setProjectSpaces", async () => {
		const user = userEvent.setup();
		const { api } = await import("../../rpc");
		render(
			<I18nProvider>
				<ProjectSpacesField projectId="p1" />
			</I18nProvider>,
		);
		await waitFor(() => expect(screen.getByTestId("space-chip-sp_a")).toBeInTheDocument());
		await user.click(screen.getByTestId("project-spaces-edit"));
		await user.click(screen.getByTestId("space-picker-row-sp_b"));
		expect(api.request.setProjectSpaces).toHaveBeenCalledWith({ projectId: "p1", spaceIds: ["sp_a", "sp_b"] });
	});

	// The chip is the thing being removed, so removal lives on it — not only in
	// the picker, where "untick the one that is on" is a second mental step.
	it("removes a membership from the chip itself", async () => {
		const user = userEvent.setup();
		const { api } = await import("../../rpc");
		render(
			<I18nProvider>
				<ProjectSpacesField projectId="p1" />
			</I18nProvider>,
		);
		await waitFor(() => expect(screen.getByTestId("space-chip-sp_a")).toBeInTheDocument());
		await user.click(screen.getByTestId("space-chip-remove-sp_a"));
		expect(api.request.setProjectSpaces).toHaveBeenCalledWith({ projectId: "p1", spaceIds: [] });
	});

	it("toasts when a space auto-deletes after losing its last member", async () => {
		const user = userEvent.setup();
		const { api } = await import("../../rpc");
		(api.request.setProjectSpaces as ReturnType<typeof vi.fn>).mockResolvedValue({
			file: { version: 1, spaces: [], order: [] },
			autoDeleted: [{ id: "sp_a", name: "Alpha", parentId: null, projectIds: [], createdAt: 1, deleted: true }],
		});
		render(
			<I18nProvider>
				<ProjectSpacesField projectId="p1" />
			</I18nProvider>,
		);
		await waitFor(() => expect(screen.getByTestId("space-chip-sp_a")).toBeInTheDocument());
		await user.click(screen.getByTestId("project-spaces-edit"));
		await user.click(screen.getByTestId("space-picker-row-sp_a"));
		await waitFor(() => expect(toastMock.info).toHaveBeenCalled());
	});
});

describe("ProjectSpacesField — deferred mode", () => {
	it("never calls RPC mutations, only onChange", async () => {
		const user = userEvent.setup();
		const onChange = vi.fn();
		const { api } = await import("../../rpc");
		render(
			<I18nProvider>
				<ProjectSpacesField mode="deferred" value={[]} onChange={onChange} />
			</I18nProvider>,
		);
		await waitFor(() => expect(screen.getByTestId("project-spaces-edit")).toBeInTheDocument());
		await user.click(screen.getByTestId("project-spaces-edit"));
		await user.click(screen.getByTestId("space-picker-row-sp_a"));
		expect(onChange).toHaveBeenCalledWith(["sp_a"]);
		expect(api.request.setProjectSpaces).not.toHaveBeenCalled();
	});
});
