import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import AboutModal from "../AboutModal";
import { I18nProvider } from "../../i18n";

function renderAbout(onClose = vi.fn()) {
	render(
		<I18nProvider>
			<AboutModal version="1.2.3" onClose={onClose} />
		</I18nProvider>,
	);
	return onClose;
}

describe("AboutModal", () => {
	it("shows the app name and version", () => {
		renderAbout();
		expect(screen.getByText("dev-3.0")).toBeInTheDocument();
		expect(screen.getByText("Version 1.2.3")).toBeInTheDocument();
	});

	it("calls onClose when the Close button is clicked", async () => {
		const user = userEvent.setup();
		const onClose = renderAbout();
		await user.click(screen.getByRole("button", { name: "Close" }));
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it("opens the website in a new tab", async () => {
		const user = userEvent.setup();
		const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
		renderAbout();
		await user.click(screen.getByRole("button", { name: "Website" }));
		expect(openSpy).toHaveBeenCalledWith("https://h0x91b.github.io/dev-3.0/", "_blank");
		openSpy.mockRestore();
	});
});
