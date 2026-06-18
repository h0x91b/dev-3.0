import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nProvider } from "../../i18n";
import CommandPaletteModal from "../CommandPaletteModal";
import type { CommandContext } from "../../commands";

function renderModal(
	context: CommandContext = { hasProject: true, hasTask: true },
	handlers: { onRun?: (id: string) => void; onClose?: () => void } = {},
) {
	const onRun = handlers.onRun ?? vi.fn();
	const onClose = handlers.onClose ?? vi.fn();
	render(
		<I18nProvider>
			<CommandPaletteModal context={context} onRun={onRun} onClose={onClose} />
		</I18nProvider>,
	);
	return { onRun, onClose };
}

describe("CommandPaletteModal", () => {
	it("lists commands and filters as the user types", async () => {
		const user = userEvent.setup();
		renderModal();
		await user.type(screen.getByRole("textbox"), "dark");
		const options = screen.getAllByRole("option");
		expect(options).toHaveLength(1);
		expect(options[0].textContent).toContain("dark");
	});

	it("runs the highlighted command on Enter via its action id", async () => {
		const user = userEvent.setup();
		const { onRun } = renderModal();
		await user.type(screen.getByRole("textbox"), "Theme: light");
		await user.keyboard("{Enter}");
		expect(onRun).toHaveBeenCalledWith("set-theme-light");
	});

	it("hides task-scoped commands when there is no active task", async () => {
		const user = userEvent.setup();
		renderModal({ hasProject: true, hasTask: false });
		await user.type(screen.getByRole("textbox"), "Toggle watch");
		expect(screen.queryAllByRole("option")).toHaveLength(0);
	});

	it("closes on Escape", async () => {
		const user = userEvent.setup();
		const { onClose } = renderModal();
		await user.keyboard("{Escape}");
		expect(onClose).toHaveBeenCalled();
	});

	it("shows an empty state when nothing matches", async () => {
		const user = userEvent.setup();
		renderModal();
		await user.type(screen.getByRole("textbox"), "zzzzz");
		expect(screen.queryAllByRole("option")).toHaveLength(0);
		expect(screen.getByText("No matching commands")).toBeTruthy();
	});
});
