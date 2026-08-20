import { createEvent, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nProvider } from "../../i18n";
import SpacesRail from "../SpacesRail";
import { HOME_GROUP_ID } from "../../utils/spaceGroups";
import type { Space } from "../../../shared/types";

const spaces: Space[] = [
	{ id: "sp_a", name: "Client X", parentId: null, projectIds: ["p1", "p2"], createdAt: 1 },
	{ id: "sp_b", name: "Labs", parentId: null, projectIds: ["p3"], createdAt: 1 },
];

function renderRail(over?: Partial<React.ComponentProps<typeof SpacesRail>>) {
	const props = {
		spaces,
		projectCountOf: (id: string) => (id === "sp_a" ? 2 : 1),
		activityOf: (id: string) => (id === "sp_a" ? { needsYou: 1, working: 2 } : { needsYou: 0, working: 0 }),
		homeActivity: { needsYou: 0, working: 3 },
		maskedSpaceIds: new Set<string>(),
		totalProjects: 5,
		homeCount: 2,
		selectedSpaceId: null,
		onSelect: vi.fn(),
		onNewSpace: vi.fn(),
		onReorder: vi.fn(),
		...over,
	};
	render(
		<I18nProvider>
			<SpacesRail {...props} />
		</I18nProvider>,
	);
	return props;
}

describe("SpacesRail", () => {
	it("lists All projects, every space with its count, and the computed Home group", () => {
		renderRail();
		expect(screen.getByTestId("rail-all-projects")).toHaveTextContent("All projects");
		expect(screen.getByTestId("rail-all-projects")).toHaveTextContent("5");
		expect(screen.getByTestId("rail-space-sp_a")).toHaveTextContent("Client X");
		expect(screen.getByTestId("rail-space-sp_a")).toHaveTextContent("2");
		expect(screen.getByTestId("rail-home")).toHaveTextContent("Home");
	});

	it("hides Home when every project belongs to a space", () => {
		renderRail({ homeCount: 0 });
		expect(screen.queryByTestId("rail-home")).not.toBeInTheDocument();
	});

	it("reports the selection instead of navigating", async () => {
		const user = userEvent.setup();
		const props = renderRail();
		await user.click(screen.getByTestId("rail-space-sp_b"));
		expect(props.onSelect).toHaveBeenCalledWith("sp_b");
		await user.click(screen.getByTestId("rail-home"));
		expect(props.onSelect).toHaveBeenCalledWith(HOME_GROUP_ID);
		await user.click(screen.getByTestId("rail-all-projects"));
		expect(props.onSelect).toHaveBeenCalledWith(null);
	});

	it("marks the active entry with aria-pressed", () => {
		renderRail({ selectedSpaceId: "sp_a" });
		expect(screen.getByTestId("rail-space-sp_a")).toHaveAttribute("aria-pressed", "true");
		expect(screen.getByTestId("rail-all-projects")).toHaveAttribute("aria-pressed", "false");
	});

	it("masks a space name whose member project is sensitive", () => {
		renderRail({ maskedSpaceIds: new Set(["sp_a"]) });
		expect(screen.getByTestId("rail-space-sp_a").querySelector(".streamer-private")).not.toBeNull();
		expect(screen.getByTestId("rail-space-sp_b").querySelector(".streamer-private")).toBeNull();
	});

	it("masks the count too, not just the name", () => {
		renderRail({ maskedSpaceIds: new Set(["sp_a"]) });
		const row = screen.getByTestId("rail-space-sp_a");
		const readableNumbers = [...row.querySelectorAll("*")].filter(
			(el) => el.children.length === 0 && /^\d+$/.test((el.textContent ?? "").trim()) && !el.className.includes("streamer-private"),
		);
		expect(readableNumbers).toHaveLength(0);
	});

	it("shows a row's needs-you / working split only when non-zero", () => {
		renderRail();
		const clientX = screen.getByTestId("rail-space-sp_a");
		expect(clientX.querySelector('[aria-label="1 need you"]')).not.toBeNull();
		expect(clientX.querySelector('[aria-label="2 working"]')).not.toBeNull();
		// Labs has no active tasks — nothing but the project count renders.
		const labs = screen.getByTestId("rail-space-sp_b");
		expect(labs.querySelector('[aria-label*="need you"]')).toBeNull();
		expect(labs.querySelector('[aria-label*="working"]')).toBeNull();
		// The computed Home group carries its split too.
		expect(screen.getByTestId("rail-home").querySelector('[aria-label="3 working"]')).not.toBeNull();
	});

	it("masks the activity split of a masked space", () => {
		renderRail({ maskedSpaceIds: new Set(["sp_a"]) });
		const row = screen.getByTestId("rail-space-sp_a");
		for (const label of ["1 need you", "2 working"]) {
			const el = row.querySelector(`[aria-label="${label}"]`);
			expect(el?.classList.contains("streamer-private")).toBe(true);
		}
	});

	it("opens the New Space flow", async () => {
		const user = userEvent.setup();
		const props = renderRail();
		await user.click(screen.getByTestId("rail-new-space"));
		expect(props.onNewSpace).toHaveBeenCalled();
	});
});

describe("SpacesRail — drag to reorder", () => {
	function dragRail(fromId: string, toId: string, atBottomHalf: boolean) {
		const from = screen.getByTestId(`rail-space-${fromId}`);
		const to = screen.getByTestId(`rail-space-${toId}`);
		// happy-dom has no layout, so pin the target's box for the side maths.
		to.getBoundingClientRect = () =>
			({ top: 0, height: 40, bottom: 40, left: 0, right: 0, width: 100, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
		const store = new Map<string, string>();
		const dataTransfer = {
			setData: (k: string, v: string) => store.set(k, v),
			getData: (k: string) => store.get(k) ?? "",
			effectAllowed: "",
			dropEffect: "",
		};
		const clientY = atBottomHalf ? 30 : 10;
		fireEvent.dragStart(from, { dataTransfer });
		// happy-dom's synthetic drag events drop `clientY`, so pin it explicitly.
		for (const make of [createEvent.dragOver, createEvent.drop]) {
			const event = make(to, { dataTransfer });
			Object.defineProperty(event, "clientY", { get: () => clientY });
			fireEvent(to, event);
		}
	}

	it("persists the new order when a space is dropped after another", () => {
		const props = renderRail();
		dragRail("sp_b", "sp_a", true);
		expect(props.onReorder).toHaveBeenCalledWith(["sp_a", "sp_b"]);
	});

	it("persists the new order when a space is dropped before another", () => {
		const props = renderRail();
		dragRail("sp_b", "sp_a", false);
		expect(props.onReorder).toHaveBeenCalledWith(["sp_b", "sp_a"]);
	});

	it("is a no-op when a space is dropped on itself", () => {
		const props = renderRail();
		dragRail("sp_a", "sp_a", true);
		expect(props.onReorder).not.toHaveBeenCalled();
	});

	it("does not make rows draggable when no reorder handler is given", () => {
		renderRail({ onReorder: undefined });
		expect(screen.getByTestId("rail-space-sp_a")).not.toHaveAttribute("draggable", "true");
	});

	it("never makes All projects or Home draggable — neither is an ordered space", () => {
		renderRail();
		expect(screen.getByTestId("rail-all-projects")).not.toHaveAttribute("draggable", "true");
		expect(screen.getByTestId("rail-home")).not.toHaveAttribute("draggable", "true");
	});
});

describe("SpacesRail — a single space", () => {
	it("is not draggable, because there is no order to change", () => {
		renderRail({ spaces: [spaces[0]] });
		expect(screen.getByTestId("rail-space-sp_a")).not.toHaveAttribute("draggable", "true");
	});

	it("stays draggable as soon as a second space exists", () => {
		renderRail();
		expect(screen.getByTestId("rail-space-sp_a")).toHaveAttribute("draggable", "true");
	});
});

describe("SpacesRail — reorder mode", () => {
	it("advertises the drag with a resting grip, not just the cursor", () => {
		renderRail();
		// The glyph is aria-hidden, so it is found by its title, which is the only
		// thing a pointer user can discover before committing to a drag.
		const row = screen.getByTestId("rail-space-sp_a");
		expect(row.querySelector('[title="Drag to reorder spaces"]')).not.toBeNull();
	});

	it("offers no reorder mode when there is nothing to reorder", () => {
		renderRail({ spaces: [spaces[0]] });
		expect(screen.queryByTestId("rail-reorder-toggle")).not.toBeInTheDocument();
		renderRail({ onReorder: undefined });
		expect(screen.queryByTestId("rail-reorder-toggle")).not.toBeInTheDocument();
	});

	it("moves a space down by one and persists the whole order", async () => {
		const user = userEvent.setup();
		const props = renderRail();
		await user.click(screen.getByTestId("rail-reorder-toggle"));
		await user.click(screen.getByTestId("rail-space-down-sp_a"));
		expect(props.onReorder).toHaveBeenCalledWith(["sp_b", "sp_a"]);
	});

	it("moves a space up by one", async () => {
		const user = userEvent.setup();
		const props = renderRail();
		await user.click(screen.getByTestId("rail-reorder-toggle"));
		await user.click(screen.getByTestId("rail-space-up-sp_b"));
		expect(props.onReorder).toHaveBeenCalledWith(["sp_b", "sp_a"]);
	});

	it("disables the step that would fall off either end", async () => {
		const user = userEvent.setup();
		renderRail();
		await user.click(screen.getByTestId("rail-reorder-toggle"));
		expect(screen.getByTestId("rail-space-up-sp_a")).toBeDisabled();
		expect(screen.getByTestId("rail-space-down-sp_b")).toBeDisabled();
		expect(screen.getByTestId("rail-space-down-sp_a")).toBeEnabled();
	});

	it("stops filtering while reordering — a row is a thing being moved, not a filter", async () => {
		const user = userEvent.setup();
		const props = renderRail();
		await user.click(screen.getByTestId("rail-reorder-toggle"));
		await user.click(screen.getByTestId("rail-space-sp_a"));
		expect(props.onSelect).not.toHaveBeenCalled();
		// Home is not an ordered space, so it has no place in the mode.
		expect(screen.queryByTestId("rail-home")).not.toBeInTheDocument();
	});

	it("drops drag while in the mode, so one gesture owns the order at a time", async () => {
		const user = userEvent.setup();
		renderRail();
		await user.click(screen.getByTestId("rail-reorder-toggle"));
		expect(screen.getByTestId("rail-space-sp_a")).not.toHaveAttribute("draggable", "true");
	});

	it("leaves the mode and restores filtering", async () => {
		const user = userEvent.setup();
		const props = renderRail();
		await user.click(screen.getByTestId("rail-reorder-toggle"));
		await user.click(screen.getByTestId("rail-reorder-toggle"));
		await user.click(screen.getByTestId("rail-space-sp_a"));
		expect(props.onSelect).toHaveBeenCalledWith("sp_a");
		expect(screen.getByTestId("rail-home")).toBeInTheDocument();
	});
});
