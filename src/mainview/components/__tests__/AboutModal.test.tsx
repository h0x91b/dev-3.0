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
	it("traps focus inside the dialog on open", () => {
		renderAbout();
		const dialog = screen.getByRole("dialog");
		expect(dialog.contains(document.activeElement)).toBe(true);
	});

	it("shows the app name and version", () => {
		renderAbout();
		expect(screen.getByText("dev-3.0")).toBeInTheDocument();
		expect(screen.getByText("Version 1.2.3")).toBeInTheDocument();
	});

	// A canary install and the stable release of the same version report the SAME version
	// string here: the bundle's version.json never carries the `+canary.<sha>` suffix,
	// because `dev3 doctor` compares it against the CLI version by string equality. The
	// channel baked into the bundle is therefore the only thing that can tell them apart.
	it("marks a canary install so it is not mistaken for the release of the same version", () => {
		render(
			<I18nProvider>
				<AboutModal version="1.42.3" buildChannel="canary" onClose={vi.fn()} />
			</I18nProvider>,
		);
		expect(screen.getByText("Canary")).toBeInTheDocument();
	});

	it("leaves a stable install unmarked", () => {
		render(
			<I18nProvider>
				<AboutModal version="1.42.3" buildChannel="stable" onClose={vi.fn()} />
			</I18nProvider>,
		);
		expect(screen.queryByText("Canary")).toBeNull();
	});

	it("calls onClose when the Close button is clicked", async () => {
		const user = userEvent.setup();
		const onClose = renderAbout();
		await user.click(screen.getByRole("button", { name: "Close" }));
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it("closes on Escape and prevents the default (native fullscreen exit)", () => {
		const onClose = renderAbout();
		const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
		window.dispatchEvent(event);
		expect(onClose).toHaveBeenCalledTimes(1);
		expect(event.defaultPrevented).toBe(true);
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
