import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import CodexProfileRepairModal from "../CodexProfileRepairModal";
import { I18nProvider } from "../../i18n";

// ---------------------------------------------------------------------------
// The dialog exists because dev3 broke somebody else's tool and will not fix it
// behind their back. Three answers, three different consequences: repair now,
// ask me next launch, never ask again. The file it would edit is named on
// screen, and a failed write says so instead of pretending it worked.
// ---------------------------------------------------------------------------

const CONFIG_PATH = "/Users/testuser/.codex/config.toml";

function renderModal(overrides: Partial<Parameters<typeof CodexProfileRepairModal>[0]> = {}) {
	const props = {
		configPath: CONFIG_PATH,
		onRepair: vi.fn(async () => true),
		onLater: vi.fn(),
		onNever: vi.fn(),
		...overrides,
	};
	render(
		<I18nProvider>
			<CodexProfileRepairModal {...props} />
		</I18nProvider>,
	);
	return props;
}

describe("CodexProfileRepairModal", () => {
	it("traps focus inside the dialog on open", () => {
		renderModal();
		expect(screen.getByRole("dialog").contains(document.activeElement)).toBe(true);
	});

	it("names the file it would edit and the exact line it would change", () => {
		renderModal();
		expect(screen.getByText(new RegExp(CONFIG_PATH.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))).toBeInTheDocument();
		expect(screen.getByText(/":minimal" = "read"\s+→\s+":root" = "read"/)).toBeInTheDocument();
	});

	it("repairs only when the user clicks it", async () => {
		const props = renderModal();
		expect(props.onRepair).not.toHaveBeenCalled();
		await userEvent.click(screen.getByRole("button", { name: "Fix it" }));
		expect(props.onRepair).toHaveBeenCalledTimes(1);
	});

	it("says so when the write did not land, instead of closing", async () => {
		renderModal({ onRepair: vi.fn(async () => false) });
		await userEvent.click(screen.getByRole("button", { name: "Fix it" }));
		expect(await screen.findByText(/Could not change the file/)).toBeInTheDocument();
		expect(screen.getByRole("dialog")).toBeInTheDocument();
	});

	it("keeps `Not now` and `Don't ask again` as different answers", async () => {
		const props = renderModal();
		await userEvent.click(screen.getByRole("button", { name: "Not now" }));
		expect(props.onLater).toHaveBeenCalledTimes(1);
		expect(props.onNever).not.toHaveBeenCalled();

		await userEvent.click(screen.getByRole("button", { name: "Don't ask again" }));
		expect(props.onNever).toHaveBeenCalledTimes(1);
	});

	it("treats Escape as `Not now`, never as consent", async () => {
		const props = renderModal();
		await userEvent.keyboard("{Escape}");
		expect(props.onLater).toHaveBeenCalledTimes(1);
		expect(props.onRepair).not.toHaveBeenCalled();
		expect(props.onNever).not.toHaveBeenCalled();
	});
});
