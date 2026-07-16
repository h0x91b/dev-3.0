import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import RosettaWarningModal from "../RosettaWarningModal";
import { I18nProvider } from "../../i18n";

const COMMAND = 'rm -rf "/Applications/dev-3.0.app" && brew install --cask h0x91b/dev3/dev3';

function renderModal(kind: "brew" | "dmg" = "brew", onClose = vi.fn()) {
	render(
		<I18nProvider>
			<RosettaWarningModal command={COMMAND} kind={kind} onClose={onClose} />
		</I18nProvider>,
	);
	return onClose;
}

describe("RosettaWarningModal", () => {
	it("shows the warning title and the reinstall command", () => {
		renderModal();
		expect(screen.getByText("Intel build on Apple Silicon")).toBeInTheDocument();
		expect(screen.getByText(COMMAND)).toBeInTheDocument();
	});

	it("shows the brew instruction for kind=brew", () => {
		renderModal("brew");
		expect(screen.getByText(/Quit dev-3.0, paste this in Terminal/)).toBeInTheDocument();
	});

	it("shows the DMG instruction for kind=dmg", () => {
		renderModal("dmg");
		expect(screen.getByText(/drag dev-3.0 into Applications/)).toBeInTheDocument();
	});

	it("copies the command to the clipboard and confirms", async () => {
		const user = userEvent.setup();
		const writeText = vi.fn().mockResolvedValue(undefined);
		vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
		renderModal();

		await user.click(screen.getByRole("button", { name: "Copy command" }));

		expect(writeText).toHaveBeenCalledWith(COMMAND);
		expect(await screen.findByRole("button", { name: "Copied!" })).toBeInTheDocument();
	});

	it("closes via the Remind me later button", async () => {
		const user = userEvent.setup();
		const onClose = renderModal();

		await user.click(screen.getByRole("button", { name: "Remind me later" }));

		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it("closes on Escape", () => {
		const onClose = renderModal();
		window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
		expect(onClose).toHaveBeenCalledTimes(1);
	});
});
