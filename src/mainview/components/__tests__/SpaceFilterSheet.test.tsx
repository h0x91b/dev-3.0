import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nProvider } from "../../i18n";
import SpaceFilterSheet from "../SpaceFilterSheet";
import { HOME_GROUP_ID } from "../../utils/spaceGroups";
import type { Space } from "../../../shared/types";

const spaces: Space[] = [
	{ id: "sp_a", name: "Client X", parentId: null, projectIds: ["p1", "p2"], createdAt: 1 },
	{ id: "sp_b", name: "Labs", parentId: null, projectIds: ["p3"], createdAt: 1 },
];

function renderSheet(over?: Partial<React.ComponentProps<typeof SpaceFilterSheet>>) {
	const props = {
		spaces,
		maskedSpaceIds: new Set<string>(),
		projectCountOf: (id: string) => (id === "sp_a" ? 2 : 1),
		totalProjects: 5,
		homeCount: 2,
		selectedSpaceId: null as string | null,
		onSelect: vi.fn(),
		onClose: vi.fn(),
		...over,
	};
	render(
		<I18nProvider>
			<SpaceFilterSheet {...props} />
		</I18nProvider>,
	);
	return props;
}

describe("SpaceFilterSheet", () => {
	it("offers the same choice the rail does, Everything first", () => {
		renderSheet();
		expect(screen.getByTestId("space-filter-all")).toHaveTextContent("Everything");
		expect(screen.getByTestId("space-filter-all")).toHaveTextContent("5");
		expect(screen.getByTestId("space-filter-sp_a")).toHaveTextContent("Client X");
		expect(screen.getByTestId("space-filter-sp_a")).toHaveTextContent("2");
		expect(screen.getByTestId(`space-filter-${HOME_GROUP_ID}`)).toHaveTextContent("Home");
	});

	it("defaults to Everything, not to a space", () => {
		renderSheet();
		expect(screen.getByTestId("space-filter-all")).toHaveAttribute("aria-pressed", "true");
		expect(screen.getByTestId("space-filter-sp_a")).toHaveAttribute("aria-pressed", "false");
	});

	it("hides Home when every project belongs to a space", () => {
		renderSheet({ homeCount: 0 });
		expect(screen.queryByTestId(`space-filter-${HOME_GROUP_ID}`)).not.toBeInTheDocument();
	});

	it("selects and dismisses in one tap — a filter sheet has nothing to confirm", async () => {
		const user = userEvent.setup();
		const props = renderSheet();
		await user.click(screen.getByTestId("space-filter-sp_b"));
		expect(props.onSelect).toHaveBeenCalledWith("sp_b");
		expect(props.onClose).toHaveBeenCalled();
	});

	it("masks a space whose member project is sensitive", () => {
		renderSheet({ maskedSpaceIds: new Set(["sp_a"]) });
		expect(screen.getByTestId("space-filter-sp_a").querySelector(".streamer-private")).not.toBeNull();
		expect(screen.getByTestId("space-filter-sp_b").querySelector(".streamer-private")).toBeNull();
	});
});
