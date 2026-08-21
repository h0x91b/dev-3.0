import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nProvider } from "../../i18n";
import SpaceProjectsModal from "../SpaceProjectsModal";
import type { Project, Space } from "../../../shared/types";

const space: Space = { id: "sp_a", name: "Labs", parentId: null, projectIds: ["p9"], createdAt: 1 };
// The dialog re-reads membership per write, so the mock must know p9 is a member
// of Labs and of one other space it must not lose.
const file = {
	version: 1 as const,
	order: ["sp_a", "sp_b"],
	spaces: [
		space,
		{ id: "sp_b", name: "Clients", parentId: null, projectIds: ["p9"], createdAt: 1 },
	],
};

vi.mock("../../rpc", () => ({
	api: {
		request: {
			getSpaces: vi.fn(() => Promise.resolve(file)),
			setProjectSpaces: vi.fn(() => Promise.resolve({ file, autoDeleted: [] })),
		},
	},
}));

const proj = (id: string, name: string, path: string): Project => ({
	id,
	name,
	path,
	setupScript: "",
	devScript: "",
	cleanupScript: "",
	defaultBaseBranch: "main",
	createdAt: "2025-01-01T00:00:00Z",
});

const projects = [
	proj("p1", "benchmark-waf", "/dev/work/benchmark-waf"),
	proj("p2", "home-infra", "/dev/personal/home-infra"),
	proj("p9", "already-member", "/dev/already"),
];

beforeEach(() => vi.clearAllMocks());

function renderModal(over?: Partial<React.ComponentProps<typeof SpaceProjectsModal>>) {
	const props = { space, projects, onClose: vi.fn(), onCreateProject: vi.fn(), ...over };
	render(
		<I18nProvider>
			<SpaceProjectsModal {...props} />
		</I18nProvider>,
	);
	return props;
}

describe("SpaceProjectsModal", () => {
	it("lists every project with the current members already ticked", () => {
		renderModal();
		expect(screen.getByTestId("space-projects-p1")).not.toBeChecked();
		// The member is listed, not filtered out: that is what makes removal possible.
		expect(screen.getByTestId("space-projects-p9")).toBeChecked();
	});

	it("filters by name", async () => {
		const user = userEvent.setup();
		renderModal();
		await user.type(screen.getByTestId("space-projects-search"), "bench");
		expect(screen.getByTestId("space-projects-p1")).toBeInTheDocument();
		expect(screen.queryByTestId("space-projects-p2")).not.toBeInTheDocument();
	});

	it("filters by path, since a project is often recognised by where it lives", async () => {
		const user = userEvent.setup();
		renderModal();
		await user.type(screen.getByTestId("space-projects-search"), "personal");
		expect(screen.getByTestId("space-projects-p2")).toBeInTheDocument();
		expect(screen.queryByTestId("space-projects-p1")).not.toBeInTheDocument();
	});

	it("says nothing matches", async () => {
		const user = userEvent.setup();
		renderModal();
		await user.type(screen.getByTestId("space-projects-search"), "zzz");
		expect(screen.getByText("No project matches")).toBeInTheDocument();
	});

	it("keeps Save inert until something actually changed", async () => {
		const user = userEvent.setup();
		renderModal();
		expect(screen.getByTestId("space-projects-save")).toBeDisabled();
		await user.click(screen.getByTestId("space-projects-p1"));
		expect(screen.getByTestId("space-projects-save")).toBeEnabled();
	});

	it("adds a ticked project", async () => {
		const user = userEvent.setup();
		const { api } = await import("../../rpc");
		const props = renderModal();
		await user.click(screen.getByTestId("space-projects-p1"));
		await user.click(screen.getByTestId("space-projects-save"));
		await waitFor(() => expect(props.onClose).toHaveBeenCalled());
		expect(api.request.setProjectSpaces).toHaveBeenCalledWith({ projectId: "p1", spaceIds: ["sp_a"] });
	});

	it("removes an unticked member and leaves its other spaces alone", async () => {
		const user = userEvent.setup();
		const { api } = await import("../../rpc");
		const props = renderModal();
		await user.click(screen.getByTestId("space-projects-p9"));
		await user.click(screen.getByTestId("space-projects-save"));
		await waitFor(() => expect(props.onClose).toHaveBeenCalled());
		expect(api.request.setProjectSpaces).toHaveBeenCalledWith({ projectId: "p9", spaceIds: ["sp_b"] });
	});

	it("hands off to the Add Project flow for this space", async () => {
		const user = userEvent.setup();
		const props = renderModal();
		await user.click(screen.getByTestId("space-projects-new-project"));
		expect(props.onCreateProject).toHaveBeenCalledWith(space);
	});

	it("omits the create affordance when the host cannot open that flow", () => {
		renderModal({ onCreateProject: undefined });
		expect(screen.queryByTestId("space-projects-new-project")).not.toBeInTheDocument();
	});
});
