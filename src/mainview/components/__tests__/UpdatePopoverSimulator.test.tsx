import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import UpdatePopoverSimulator from "../UpdatePopoverSimulator";
import { I18nProvider, useT } from "../../i18n";
import type { UpdatePopoverPreview } from "../../../shared/types";

const getAppVersion = vi.fn();
const previewUpdatePopover = vi.fn();

vi.mock("../../rpc", () => ({
	api: { request: { getAppVersion: (...a: unknown[]) => getAppVersion(...a), previewUpdatePopover: (...a: unknown[]) => previewUpdatePopover(...a) } },
}));

function Harness() {
	const t = useT();
	return <UpdatePopoverSimulator t={t} />;
}

function renderSim() {
	return render(
		<I18nProvider>
			<Harness />
		</I18nProvider>,
	);
}

const PREVIEW: UpdatePopoverPreview = {
	available: true,
	changelog: { features: ["Dark mode toggle", "Swipe to dismiss"], featureCount: 3, fixCount: 4 },
	diagnostics: { prevTag: "v1.2.3", usedFallback: false, windowFiles: ["feature-dark-mode", "fix-toast"], totalEntries: 42, includesUncommitted: true },
};

beforeEach(() => {
	getAppVersion.mockReset();
	previewUpdatePopover.mockReset();
});

describe("UpdatePopoverSimulator gate", () => {
	it("renders nothing on non-dev builds", async () => {
		getAppVersion.mockResolvedValue({ version: "1.2.4", channel: "stable", buildChannel: "stable" });
		renderSim();
		await waitFor(() => expect(getAppVersion).toHaveBeenCalled());
		expect(screen.queryByText("Preview update popover")).toBeNull();
	});

	it("shows the trigger button on the dev build channel", async () => {
		getAppVersion.mockResolvedValue({ version: "1.2.4", channel: "dev", buildChannel: "dev" });
		renderSim();
		expect(await screen.findByText("Preview update popover")).toBeTruthy();
	});
});

describe("UpdatePopoverSimulatorModal", () => {
	it("renders the popover 1:1 with a disabled Restart and shows diagnostics", async () => {
		getAppVersion.mockResolvedValue({ version: "1.2.4", channel: "dev", buildChannel: "dev" });
		previewUpdatePopover.mockResolvedValue(PREVIEW);
		renderSim();

		await userEvent.click(await screen.findByText("Preview update popover"));

		// Popover feature titles + rollup.
		expect(await screen.findByText("Dark mode toggle")).toBeTruthy();
		expect(screen.getByText("Swipe to dismiss")).toBeTruthy();
		expect(screen.getByText(/\+1 more feature/)).toBeTruthy();
		expect(screen.getByText(/4 fixes/)).toBeTruthy();

		// Restart is disabled in preview so it never quits the app.
		const restart = screen.getByRole("button", { name: "Restart to Update" });
		expect((restart as HTMLButtonElement).disabled).toBe(true);

		// Diagnostics: tag, window files, totals.
		expect(screen.getByText("v1.2.3")).toBeTruthy();
		expect(screen.getByText("feature-dark-mode")).toBeTruthy();
		expect(screen.getByText(/42 total entries/)).toBeTruthy();
	});

	it("shows the unavailable state when the preview is not available", async () => {
		getAppVersion.mockResolvedValue({ version: "1.2.4", channel: "dev", buildChannel: "dev" });
		previewUpdatePopover.mockResolvedValue({
			available: false,
			reason: "no-change-logs-dir",
			changelog: null,
			diagnostics: { prevTag: null, usedFallback: false, windowFiles: [], totalEntries: 0, includesUncommitted: true },
		} satisfies UpdatePopoverPreview);
		renderSim();

		await userEvent.click(await screen.findByText("Preview update popover"));
		expect(await screen.findByText(/Not available/)).toBeTruthy();
		expect(screen.getByText("no-change-logs-dir")).toBeTruthy();
	});
});
