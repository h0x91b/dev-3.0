import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nProvider } from "../../i18n";
import { api } from "../../rpc";
import SpaceGroupedProjects, { type RowReorderCtx } from "../SpaceGroupedProjects";
import type { DashboardGroup } from "../../utils/spaceGroups";
import type { Project, Space } from "../../../shared/types";

vi.mock("../../rpc", () => ({
	api: {
		request: {
			reorderSpaces: vi.fn(() => Promise.resolve({ version: 1, spaces: [], order: [] })),
			reorderSpaceProjects: vi.fn(() =>
				Promise.resolve({ id: "sp_a", name: "Alpha", parentId: null, projectIds: [], createdAt: 1 }),
			),
		},
	},
}));

const proj = (id: string): Project => ({
	id,
	name: id,
	path: `/tmp/${id}`,
	setupScript: "",
	devScript: "",
	cleanupScript: "",
	defaultBaseBranch: "main",
	createdAt: "2025-01-01T00:00:00Z",
});

const sp = (id: string, name: string, projectIds: string[]): Space => ({
	id,
	name,
	parentId: null,
	projectIds,
	createdAt: 1,
});

const groups: DashboardGroup[] = [
	{ space: sp("sp_a", "Alpha", ["p1", "p2"]), projects: [proj("p1"), proj("p2")] },
	{ space: sp("sp_b", "Beta", ["p1"]), projects: [proj("p1")] },
	{ space: null, projects: [proj("p3")] },
];

function renderGroups(sensitive: ReadonlySet<string> = new Set()) {
	return render(
		<I18nProvider>
			<SpaceGroupedProjects
				groups={groups}
				sensitiveProjectIds={sensitive}
				needsYouCountOf={() => 0}
				workingCountOf={() => 0}
				renderProject={(p) => <div data-testid={`row-${p.id}`}>{p.name}</div>}
				renderBottomBlockProject={(p) => <div data-testid={`rest-row-${p.id}`}>{p.name}</div>}
			/>
		</I18nProvider>,
	);
}

beforeEach(() => {
	localStorage.removeItem("dev3-collapsed-spaces");
	vi.clearAllMocks();
});

describe("SpaceGroupedProjects", () => {
	it("renders headers with member counts and the provided rows under each, repeating shared projects", () => {
		renderGroups();
		expect(screen.getByTestId("space-header-sp_a")).toHaveTextContent("Alpha");
		expect(screen.getByTestId("space-header-sp_b")).toHaveTextContent("Beta");
		// p1 renders under both of its spaces.
		expect(screen.getAllByTestId("row-p1")).toHaveLength(2);
		// Bottom block renders through its own callback under the computed heading.
		expect(screen.getByTestId("space-group-rest")).toHaveTextContent("Home");
		expect(screen.getByTestId("rest-row-p3")).toBeInTheDocument();
	});

	it("collapse hides a space's rows and persists to localStorage", async () => {
		const user = userEvent.setup();
		renderGroups();
		await user.click(screen.getByTestId("space-header-sp_a"));
		expect(screen.getAllByTestId("row-p1")).toHaveLength(1); // only Beta's copy remains
		expect(screen.queryByTestId("row-p2")).not.toBeInTheDocument();
		expect(JSON.parse(localStorage.getItem("dev3-collapsed-spaces")!)).toEqual(["sp_a"]);
	});

	it("masks the header name when a member project is sensitive", () => {
		renderGroups(new Set(["p2"]));
		const alpha = screen.getByTestId("space-header-sp_a");
		expect(alpha.querySelector(".streamer-private")).not.toBeNull();
		const beta = screen.getByTestId("space-header-sp_b");
		expect(beta.querySelector(".streamer-private")).toBeNull();
	});

	it("masks the counts alongside the name — they say how much work a private client has", () => {
		render(
			<I18nProvider>
				<SpaceGroupedProjects
					groups={groups}
					sensitiveProjectIds={new Set(["p2"])}
					needsYouCountOf={() => 1}
					workingCountOf={() => 2}
					renderProject={(p) => <div data-testid={`row-${p.id}`}>{p.name}</div>}
					renderBottomBlockProject={(p) => <div data-testid={`rest-row-${p.id}`}>{p.name}</div>}
				/>
			</I18nProvider>,
		);
		const masked = screen.getByTestId("space-header-sp_a");
		const readable = [...masked.querySelectorAll("*")].filter(
			(el) => el.children.length === 0 && /\d/.test(el.textContent ?? "") && !el.className.includes("streamer-private"),
		);
		expect(readable).toHaveLength(0);
	});
});

describe("SpaceGroupedProjects — header details from the mock", () => {
	it("shows the project count and split need-you / working counts, with no letter badge", () => {
		render(
			<I18nProvider>
				<SpaceGroupedProjects
					groups={groups}
					sensitiveProjectIds={new Set()}
					needsYouCountOf={(id) => (id === "p1" ? 1 : 0)}
					workingCountOf={(id) => (id === "p2" ? 2 : 0)}
					renderProject={(p) => <div data-testid={`row-${p.id}`}>{p.name}</div>}
					renderBottomBlockProject={(p) => <div data-testid={`rest-row-${p.id}`}>{p.name}</div>}
				/>
			</I18nProvider>,
		);
		const header = screen.getByTestId("space-header-sp_a");
		expect(header).toHaveTextContent("2 projects");
		expect(header).toHaveTextContent("1 need you");
		expect(header).toHaveTextContent("2 working");
		// The name carries the identity; a first-letter badge would only repeat it.
		const singleLetterNodes = [...header.querySelectorAll("*")].filter(
			(el) => el.children.length === 0 && /^[A-Z]$/.test((el.textContent ?? "").trim()),
		);
		expect(singleLetterNodes).toHaveLength(0);
	});

	it("offers the add-projects control only when the handler is provided", async () => {
		const user = userEvent.setup();
		const onAddProjects = vi.fn();
		render(
			<I18nProvider>
				<SpaceGroupedProjects
					groups={groups}
					sensitiveProjectIds={new Set()}
					needsYouCountOf={() => 0}
					workingCountOf={() => 0}
					renderProject={(p) => <div data-testid={`row-${p.id}`}>{p.name}</div>}
					renderBottomBlockProject={(p) => <div data-testid={`rest-row-${p.id}`}>{p.name}</div>}
					onAddProjects={onAddProjects}
				/>
			</I18nProvider>,
		);
		await user.click(screen.getByTestId("space-add-projects-sp_a"));
		expect(onAddProjects).toHaveBeenCalledWith(expect.objectContaining({ id: "sp_a" }));
	});

	it("passes the owning space id to the row renderer so chips can omit it", () => {
		const renderProject = vi.fn((p) => <div data-testid={`row-${p.id}`}>{p.name}</div>);
		render(
			<I18nProvider>
				<SpaceGroupedProjects
					groups={groups}
					sensitiveProjectIds={new Set()}
					needsYouCountOf={() => 0}
					workingCountOf={() => 0}
					renderProject={renderProject}
					renderBottomBlockProject={(p) => <div data-testid={`rest-row-${p.id}`}>{p.name}</div>}
				/>
			</I18nProvider>,
		);
		expect(renderProject).toHaveBeenCalledWith(
			expect.objectContaining({ id: "p1" }),
			expect.anything(),
			"sp_a",
		);
	});
});

describe("SpaceGroupedProjects — nothing to reorder", () => {
	const soloGroups: DashboardGroup[] = [
		{ space: sp("sp_solo", "Solo", ["p1"]), projects: [proj("p1")] },
	];

	function renderWith(
		groupsArg: DashboardGroup[],
		renderProject: (project: Project, reorder: RowReorderCtx, groupSpaceId: string | null) => React.ReactNode = (p) => (
			<div data-testid={`row-${p.id}`}>{p.name}</div>
		),
	) {
		render(
			<I18nProvider>
				<SpaceGroupedProjects
					groups={groupsArg}
					sensitiveProjectIds={new Set()}
					needsYouCountOf={() => 0}
					workingCountOf={() => 0}
					renderProject={renderProject}
					renderBottomBlockProject={(p) => <div data-testid={`rest-row-${p.id}`}>{p.name}</div>}
				/>
			</I18nProvider>,
		);
	}

	it("tells a lone project's row not to render reorder controls", () => {
		const seen: boolean[] = [];
		renderWith(soloGroups, (p, ctx) => {
			seen.push(ctx.showReorder);
			return <div data-testid={`row-${p.id}`}>{p.name}</div>;
		});
		expect(seen).toEqual([false]);
	});

	it("keeps reorder controls for a space holding several projects", () => {
		const seen: boolean[] = [];
		renderWith(groups, (p, ctx) => {
			seen.push(ctx.showReorder);
			return <div data-testid={`row-${p.id}`}>{p.name}</div>;
		});
		// Client X holds two projects; Beta holds one.
		expect(seen.slice(0, 2)).toEqual([true, true]);
		expect(seen[2]).toBe(false);
	});

	// Space ORDER belongs to the rail, which is the collapsed name-only list.
	// A second grip here meant dragging a header across a page hundreds of
	// pixels tall, and it never existed on touch at all.
	it("carries no space-order grip on a header, whatever the space count", () => {
		renderWith(groups);
		for (const id of ["sp_a", "sp_b"]) {
			const header = screen.getByTestId(`space-header-${id}`).parentElement!;
			expect(header.querySelector('[draggable="true"]')).toBeNull();
		}
	});

	// Dragging is only worth doing if the list you are dropping into fits on the
	// screen, so every row that can take THIS drop collapses — and no other, since
	// a drop across groups would change membership and is refused.
	it("collapses only the group whose row is being dragged", () => {
		const flags = new Map<string, boolean>();
		renderWith(groups, (p, ctx, spaceId) => {
			flags.set(`${spaceId}:${p.id}`, ctx.groupDragActive);
			return (
				<div
					key={`${spaceId}:${p.id}`}
					data-testid={`row-${spaceId}-${p.id}`}
					draggable
					onDragStart={ctx.onDragStart}
				>
					{p.name}
				</div>
			);
		});
		fireEvent.dragStart(screen.getByTestId("row-sp_a-p1"), {
			dataTransfer: { setData: vi.fn(), effectAllowed: "" },
		});
		expect(flags.get("sp_a:p1")).toBe(true);
		expect(flags.get("sp_a:p2")).toBe(true);
		expect(flags.get("sp_b:p1")).toBe(false);
	});

	it("does not reorder spaces when a header is dragged", () => {
		renderWith(groups);
		const header = screen.getByTestId("space-header-sp_a").parentElement!;
		fireEvent.dragOver(header);
		fireEvent.drop(header);
		expect(vi.mocked(api.request.reorderSpaces)).not.toHaveBeenCalled();
	});
});
