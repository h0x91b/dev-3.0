import { render, screen } from "@testing-library/react";
import UpdatePopoverSimulatorModal from "../UpdatePopoverSimulatorModal";
import { I18nProvider } from "../../i18n";
import type { UpdatePopoverPreview } from "../../../shared/types";

const getAppVersion = vi.fn();
const previewUpdatePopover = vi.fn();

vi.mock("../../rpc", () => ({
	api: { request: { getAppVersion: (...a: unknown[]) => getAppVersion(...a), previewUpdatePopover: (...a: unknown[]) => previewUpdatePopover(...a) } },
}));

function renderModal() {
	return render(
		<I18nProvider>
			<UpdatePopoverSimulatorModal onClose={() => {}} />
		</I18nProvider>,
	);
}

const PREVIEW: UpdatePopoverPreview = {
	available: true,
	changelog: { features: ["Dark mode toggle", "Swipe to dismiss"], featureCount: 3, fixCount: 4 },
	diagnostics: {
		prevTag: "v1.2.3",
		usedFallback: false,
		windowFiles: ["feature-dark-mode", "fix-toast", "refactor-cleanup"],
		totalEntries: 42,
		includesUncommitted: true,
		mergedPRs: 12,
	},
};

beforeEach(() => {
	getAppVersion.mockReset();
	previewUpdatePopover.mockReset();
	getAppVersion.mockResolvedValue({ version: "1.2.4", channel: "dev", buildChannel: "dev" });
});

describe("UpdatePopoverSimulatorModal", () => {
	it("renders the popover 1:1 with a disabled Restart and shows diagnostics", async () => {
		previewUpdatePopover.mockResolvedValue(PREVIEW);
		renderModal();

		// Popover feature titles + rollup.
		expect(await screen.findByText("Dark mode toggle")).toBeTruthy();
		expect(screen.getByText("Swipe to dismiss")).toBeTruthy();
		expect(screen.getByText(/\+1 more feature/)).toBeTruthy();
		expect(screen.getByText(/4 fixes/)).toBeTruthy();

		// Preview mimics the toast layout: a static-countdown Restart + a Postpone,
		// both disabled so the simulator never quits the app.
		const restart = screen.getByRole("button", { name: /Restart to Update \(205s\)/ });
		expect((restart as HTMLButtonElement).disabled).toBe(true);
		const postpone = screen.getByRole("button", { name: "Postpone" });
		expect((postpone as HTMLButtonElement).disabled).toBe(true);

		// Diagnostics: tag, window files, totals, merged PRs, type breakdown.
		expect(screen.getByText("v1.2.3")).toBeTruthy();
		expect(screen.getByText("feature-dark-mode")).toBeTruthy();
		expect(screen.getByText(/42 total entries/)).toBeTruthy();
		expect(screen.getByText(/12 PRs merged since the tag/)).toBeTruthy();
		// Window has 3 entries (feature+fix+refactor) but only 2 show in the popover.
		expect(screen.getByText(/only feature & fix show in the popover/)).toBeTruthy();
	});

	it("shows the unavailable state when the preview is not available", async () => {
		previewUpdatePopover.mockResolvedValue({
			available: false,
			reason: "no-change-logs-dir",
			changelog: null,
			diagnostics: { prevTag: null, usedFallback: false, windowFiles: [], totalEntries: 0, includesUncommitted: true, mergedPRs: 0 },
		} satisfies UpdatePopoverPreview);
		renderModal();

		expect(await screen.findByText(/Not available/)).toBeTruthy();
		expect(screen.getByText("no-change-logs-dir")).toBeTruthy();
	});
});
