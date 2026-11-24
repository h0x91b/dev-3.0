import { beforeAll, describe, expect, it, vi } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import type { Context } from "cordis";
import { getAppRoot } from "../../plugins/root";
import userEvent from "@testing-library/user-event";
import { I18nProvider } from "../../i18n";
import CommandPaletteModal from "../CommandPaletteModal";
import { BUILTIN_COMMANDS_PLUGIN } from "../../commands/builtins";
import type { CommandContext, CommandItem } from "../../commands/registry";
import { applyBuiltinPlugins } from "../../plugins/runtime";

function renderModal(
	context: CommandContext = { hasProject: true, hasTask: true },
	handlers: { onRun?: (command: CommandItem) => void; onClose?: () => void } = {},
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
	beforeAll(() => applyBuiltinPlugins([], [BUILTIN_COMMANDS_PLUGIN]));

	it("traps focus inside the dialog on open", () => {
		renderModal();
		const dialog = screen.getByRole("dialog");
		expect(dialog.contains(document.activeElement)).toBe(true);
	});

	it("lists commands and filters as the user types", async () => {
		const user = userEvent.setup();
		renderModal();
		await user.type(screen.getByRole("textbox"), "dark");
		const options = screen.getAllByRole("option");
		expect(options).toHaveLength(1);
		expect(options[0].textContent).toContain("dark");
	});

	it("hands the highlighted command to onRun on Enter", async () => {
		const user = userEvent.setup();
		const { onRun } = renderModal();
		await user.type(screen.getByRole("textbox"), "Theme: light");
		await user.keyboard("{Enter}");
		expect(onRun).toHaveBeenCalledWith(expect.objectContaining({ id: "builtin:set-theme-light" }));
	});

	it("hides task-scoped commands when there is no active task", async () => {
		const user = userEvent.setup();
		renderModal({ hasProject: true, hasTask: false });
		await user.type(screen.getByRole("textbox"), "Toggle watch");
		expect(screen.queryAllByRole("option")).toHaveLength(0);
	});

	it("shows the keymap combo right-aligned on a row that has a shortcut", async () => {
		const user = userEvent.setup();
		renderModal();
		await user.type(screen.getByRole("textbox"), "Open settings");
		const [row] = screen.getAllByRole("option");
		// happy-dom is neither macOS nor the Electrobun shell: the Ctrl form, remote rules.
		expect(within(row).getByTestId("command-shortcut").textContent).toBe("Ctrl+,");
	});

	it("leaves a row without a shortcut as it was", async () => {
		const user = userEvent.setup();
		renderModal();
		await user.type(screen.getByRole("textbox"), "Theme: dark");
		const [row] = screen.getAllByRole("option");
		expect(within(row).queryByTestId("command-shortcut")).toBeNull();
		expect(row.textContent).toContain("App");
	});

	it("shows the browser's way in when the desktop combo is browser-owned", async () => {
		const user = userEvent.setup();
		renderModal();
		await user.type(screen.getByRole("textbox"), "Go to Task");
		const row = screen.getAllByRole("option").find((o) => o.textContent?.includes("Go to Task"));
		expect(within(row!).getByTestId("command-shortcut").textContent).toBe("Ctrl+Shift+K then Tab");
	});

	it("closes on Escape", async () => {
		const user = userEvent.setup();
		const { onClose } = renderModal();
		await user.keyboard("{Escape}");
		expect(onClose).toHaveBeenCalled();
	});

	it("[dispose] drops a plugin's command from the open palette when the plugin unloads", async () => {
		const user = userEvent.setup();
		const fiber = getAppRoot().plugin({
			name: "leaving-commands",
			inject: ["commands"],
			apply(ctx: Context) {
				ctx.commands.register({ id: "leaving:probe", order: 999, labelKey: "command.boardView", labelVars: { name: "Zebra probe" }, category: "nav", scope: "always", run: () => {} });
			},
		});
		try {
			await act(async () => {
				await fiber;
			});
			renderModal();
			await user.type(screen.getByRole("textbox"), "Zebra probe");
			expect(screen.getAllByRole("option")).toHaveLength(1);
			await act(async () => {
				await fiber.dispose();
			});
			expect(screen.queryAllByRole("option")).toHaveLength(0);
			expect(screen.getByRole("dialog")).toBeInTheDocument();
			await user.clear(screen.getByRole("textbox"));
			await user.type(screen.getByRole("textbox"), "Theme: light");
			expect(screen.getAllByRole("option").length).toBeGreaterThan(0);
		} finally {
			// This file shares one root across tests: a failed assertion must not leak the probe.
			await fiber.dispose();
		}
	});

	it("shows an empty state when nothing matches", async () => {
		const user = userEvent.setup();
		renderModal();
		await user.type(screen.getByRole("textbox"), "zzzzz");
		expect(screen.queryAllByRole("option")).toHaveLength(0);
		expect(screen.getByText("No matching commands")).toBeTruthy();
	});
});
