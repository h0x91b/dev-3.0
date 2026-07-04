import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import HelpSpot from "../HelpSpot";
import { I18nProvider } from "../../i18n";

function renderSpot(props: React.ComponentProps<typeof HelpSpot>) {
	return render(
		<I18nProvider>
			<HelpSpot {...props} />
		</I18nProvider>,
	);
}

describe("HelpSpot", () => {
	it("renders nothing for an unknown topic id", () => {
		renderSpot({ topicId: "nope.unknown" });
		expect(screen.queryByRole("button")).not.toBeInTheDocument();
	});

	it("opens the pinned HelpCard on click and closes on Escape", async () => {
		const user = userEvent.setup();
		renderSpot({ topicId: "modal.launch-variants" });
		const spot = screen.getByRole("button", { name: "About this section" });
		await user.click(spot);
		expect(screen.getByRole("dialog", { name: "Variants" })).toBeInTheDocument();
		expect(spot).toHaveAttribute("aria-expanded", "true");
		await user.keyboard("{Escape}");
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
	});

	it("toggles the pinned card on a second click", async () => {
		const user = userEvent.setup();
		renderSpot({ topicId: "diff.modes" });
		const spot = screen.getByRole("button", { name: "About this section" });
		await user.click(spot);
		expect(screen.getByRole("dialog")).toBeInTheDocument();
		await user.click(spot);
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
	});

	it("renders ad-hoc content (custom column description)", async () => {
		const user = userEvent.setup();
		renderSpot({ content: { title: "My column", body: "Only urgent tasks live here." } });
		await user.click(screen.getByRole("button", { name: "About this section" }));
		expect(screen.getByText("My column")).toBeInTheDocument();
		expect(screen.getByText("Only urgent tasks live here.")).toBeInTheDocument();
	});

	it("shows shortcut chips for topics that declare shortcutIds", async () => {
		const user = userEvent.setup();
		renderSpot({ topicId: "board.filter-bar" });
		await user.click(screen.getByRole("button", { name: "About this section" }));
		// board.filter-bar links the focus-search shortcut ("/").
		expect(screen.getByText("/")).toBeInTheDocument();
	});
});
