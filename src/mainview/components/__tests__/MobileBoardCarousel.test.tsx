import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import MobileBoardCarousel, { type CarouselColumn } from "../MobileBoardCarousel";
import { I18nProvider } from "../../i18n";

// happy-dom does not implement Element.scrollTo; the carousel calls it on navigation.
beforeAll(() => {
	Element.prototype.scrollTo = vi.fn() as unknown as typeof Element.prototype.scrollTo;
	if (!window.matchMedia) {
		Object.defineProperty(window, "matchMedia", {
			configurable: true,
			value: (query: string) => ({ matches: false, media: query, onchange: null, addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn() }),
		});
	}
});

function makeColumns(): CarouselColumn[] {
	return [
		{ id: "todo", label: "To Do", color: "#888", count: 2, element: <div>todo-body</div> },
		{ id: "in-progress", label: "In Progress", color: "#36f", count: 1, element: <div>wip-body</div> },
		{ id: "done", label: "Done", color: "#3c3", count: 0, element: <div>done-body</div> },
	];
}

function renderCarousel(columns: CarouselColumn[]) {
	return render(
		<I18nProvider>
			<MobileBoardCarousel columns={columns} />
		</I18nProvider>,
	);
}

describe("MobileBoardCarousel", () => {
	it("renders the first column with its position and count", () => {
		renderCarousel(makeColumns());
		expect(screen.getByText("To Do")).toBeTruthy();
		expect(screen.getByText("1 / 3")).toBeTruthy();
		// Prev is disabled on the first column
		expect(screen.getByLabelText("Previous column").hasAttribute("disabled")).toBe(true);
	});

	it("advances the active column when Next is clicked", async () => {
		const user = userEvent.setup();
		renderCarousel(makeColumns());
		await user.click(screen.getByLabelText("Next column"));
		expect(screen.getByText("In Progress")).toBeTruthy();
		expect(screen.getByText("2 / 3")).toBeTruthy();
	});

	it("disables Next on the last column", async () => {
		const user = userEvent.setup();
		renderCarousel(makeColumns());
		await user.click(screen.getByLabelText("Next column"));
		await user.click(screen.getByLabelText("Next column"));
		expect(screen.getByText("3 / 3")).toBeTruthy();
		expect(screen.getByLabelText("Next column").hasAttribute("disabled")).toBe(true);
	});

	it("jumps to a column via its dot indicator", async () => {
		const user = userEvent.setup();
		renderCarousel(makeColumns());
		await user.click(screen.getByLabelText("Go to Done"));
		expect(screen.getByText("Done")).toBeTruthy();
		expect(screen.getByText("3 / 3")).toBeTruthy();
	});

	it("renders nothing when there are no columns", () => {
		const { container } = renderCarousel([]);
		expect(container.querySelector("[aria-roledescription]")).toBeNull();
	});
});
