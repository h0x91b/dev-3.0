import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { GlobalSettings, LowBatteryStatus } from "../../../../shared/types";
import { I18nProvider, useT } from "../../../i18n";
import LowBatterySettingsSection from "../LowBatterySettingsSection";

vi.mock("../../../rpc", () => ({
	isElectrobun: false,
	api: { request: { getLowBatteryStatus: vi.fn(), selectLowBatteryStyle: vi.fn() } },
}));

import { api } from "../../../rpc";

const mockedApi = vi.mocked(api, true);

function makeStatus(overrides: Partial<LowBatteryStatus> = {}): LowBatteryStatus {
	return {
		enabled: true,
		revision: "46f79bf8d55e5cd120ae8408351564e7407c3aa5",
		styleInstalled: true,
		skillInstalled: true,
		outcome: { kind: "selected" },
		...overrides,
	};
}

function Harness({
	settings,
	onToggle,
}: {
	settings: Partial<GlobalSettings>;
	onToggle: (enabled: boolean) => void;
}) {
	const t = useT();
	return (
		<LowBatterySettingsSection
			t={t}
			globalSettings={settings as GlobalSettings}
			onToggle={onToggle}
		/>
	);
}

function renderSection(settings: Partial<GlobalSettings> = {}, onToggle = vi.fn()) {
	render(
		<I18nProvider>
			<Harness settings={settings} onToggle={onToggle} />
		</I18nProvider>,
	);
	return onToggle;
}

beforeEach(() => {
	vi.clearAllMocks();
	mockedApi.request.getLowBatteryStatus.mockResolvedValue(makeStatus());
});

it("is on when the settings carry no opt-out", async () => {
	renderSection({});

	const toggle = screen.getByRole("switch", { name: "Low-battery answer format" });
	expect(toggle).toHaveAttribute("aria-checked", "true");
	await waitFor(() => expect(screen.getByText(/46f79bf8/)).toBeInTheDocument());
});

it("is off when the user opted out, and reports the opt-out upward", async () => {
	const onToggle = renderSection({ lowBatteryDisabled: true });

	const toggle = screen.getByRole("switch", { name: "Low-battery answer format" });
	expect(toggle).toHaveAttribute("aria-checked", "false");

	await userEvent.click(toggle);
	expect(onToggle).toHaveBeenCalledWith(true);
});

it("turning it off asks for a real uninstall", async () => {
	const onToggle = renderSection({});

	await userEvent.click(screen.getByRole("switch", { name: "Low-battery answer format" }));
	expect(onToggle).toHaveBeenCalledWith(false);
});

it("says plainly when the user's own output style was left alone", async () => {
	mockedApi.request.getLowBatteryStatus.mockResolvedValue(
		makeStatus({ outcome: { kind: "user-style-kept", style: "Lazy Dzen" }, selectedStyle: "Lazy Dzen" }),
	);
	renderSection({});

	await waitFor(() => expect(screen.getByText(/Lazy Dzen/)).toBeInTheDocument());
	expect(screen.getByText(/left it alone/)).toBeInTheDocument();
});

it("offers a one-click switch, and only then changes the style", async () => {
	mockedApi.request.getLowBatteryStatus.mockResolvedValue(
		makeStatus({ outcome: { kind: "user-style-kept", style: "Lazy Dzen" } }),
	);
	mockedApi.request.selectLowBatteryStyle.mockResolvedValue(makeStatus({ outcome: { kind: "selected" } }));
	renderSection({});

	const button = await screen.findByRole("button", { name: "Switch to Low Battery" });
	expect(mockedApi.request.selectLowBatteryStyle).not.toHaveBeenCalled();

	await userEvent.click(button);
	expect(mockedApi.request.selectLowBatteryStyle).toHaveBeenCalledTimes(1);
	await waitFor(() =>
		expect(screen.getByText("Selected as the Claude Code output style.")).toBeInTheDocument(),
	);
});

it("recognises an existing plugin install instead of claiming it installed one", async () => {
	mockedApi.request.getLowBatteryStatus.mockResolvedValue(
		makeStatus({ outcome: { kind: "already-on", style: "low-battery:Low Battery" } }),
	);
	renderSection({});

	await waitFor(() => expect(screen.getByText(/no second copy/)).toBeInTheDocument());
});

it("is honest about the harnesses dev3 cannot switch the format on for", async () => {
	renderSection({});
	await waitFor(() => expect(screen.getByText(/Gemini, Zed and Copilot/)).toBeInTheDocument());
});
