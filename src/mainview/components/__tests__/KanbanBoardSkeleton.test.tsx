import { render, screen } from "@testing-library/react";
import KanbanBoardSkeleton from "../KanbanBoardSkeleton";
import { I18nProvider } from "../../i18n";

function mockViewport(narrow: boolean) {
	Object.defineProperty(window, "matchMedia", {
		configurable: true,
		value: (query: string) => ({
			matches: narrow,
			media: query,
			onchange: null,
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
			addListener: vi.fn(),
			removeListener: vi.fn(),
			dispatchEvent: vi.fn(),
		}),
	});
}

function renderSkeleton() {
	return render(
		<I18nProvider>
			<KanbanBoardSkeleton appearAfterMs={0} />
		</I18nProvider>,
	);
}

describe("KanbanBoardSkeleton", () => {
	it("renders five columns on a wide viewport", () => {
		mockViewport(false);
		renderSkeleton();
		expect(screen.getAllByTestId("kanban-skeleton-column")).toHaveLength(5);
	});

	it("renders a single full-width column on a phone viewport", () => {
		mockViewport(true);
		renderSkeleton();
		expect(screen.getAllByTestId("kanban-skeleton-column")).toHaveLength(1);
		expect(screen.getByTestId("kanban-skeleton")).toBeInTheDocument();
	});
});
