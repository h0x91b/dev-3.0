import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { GlobalSettings } from "../../../../shared/types";
import type { LogRetentionChoice } from "../../../../shared/log-retention";
import { I18nProvider, useT } from "../../../i18n";
import LogRetentionSetting from "../LogRetentionSetting";

const mocks = vi.hoisted(() => ({
	getLogRetentionUsage: vi.fn(),
	confirm: vi.fn(),
}));

vi.mock("../../../rpc", () => ({
	api: { request: { getLogRetentionUsage: mocks.getLogRetentionUsage } },
}));
vi.mock("../../../confirm", () => ({ confirm: mocks.confirm }));

const DAYS = [
	{ day: "2026-11-01", bytes: 1024 * 1024 * 2 },
	{ day: "2026-08-01", bytes: 1024 * 1024 },
	{ day: "2026-04-01", bytes: 1024 * 512 },
];

/** The host answers `beyond` for the retention that was asked about. */
function hostAnswer(beyondByRetention: Record<number, { days: number; bytes: number }>) {
	mocks.getLogRetentionUsage.mockImplementation(async (params: { retentionDays?: number } = {}) => ({
		days: DAYS,
		...(params.retentionDays === undefined
			? {}
			: { beyond: beyondByRetention[params.retentionDays] ?? { days: 0, bytes: 0 } }),
	}));
}

type OnChange = (choice: LogRetentionChoice, expectedCurrent: LogRetentionChoice) => Promise<void>;

function Harness({ settings, loaded, onChange }: { settings: Partial<GlobalSettings>; loaded: boolean; onChange: OnChange }) {
	const t = useT();
	return <LogRetentionSetting t={t} globalSettings={{ updateChannel: "stable", ...settings } as GlobalSettings} loaded={loaded} onChange={onChange} />;
}

function renderSetting(settings: Partial<GlobalSettings> = {}, onChange: Mock<OnChange> = vi.fn<OnChange>(async () => {}), loaded = true) {
	render(
		<I18nProvider>
			<Harness settings={settings} loaded={loaded} onChange={onChange} />
		</I18nProvider>,
	);
	return { onChange, select: () => screen.getByTestId("log-retention") as HTMLSelectElement };
}

const options = (select: HTMLSelectElement) => Array.from(select.options).map((option) => option.textContent);

beforeEach(() => {
	mocks.getLogRetentionUsage.mockReset();
	mocks.confirm.mockReset();
	hostAnswer({ 90: { days: 2, bytes: 1024 * 1024 * 1.5 } });
	mocks.confirm.mockResolvedValue(true);
});

describe("LogRetentionSetting", () => {
	it("offers the five choices and shows the default as 30 days", async () => {
		const { select } = renderSetting();
		expect(options(select())).toEqual(["30 days", "90 days", "180 days", "365 days", "Keep forever"]);
		expect(select().value).toBe("30");
	});

	it("reflects a stored value, including forever", () => {
		const { select } = renderSetting({ logRetentionDays: "forever" });
		expect(select().value).toBe("forever");
	});

	it("offers a stored day count outside the standard list as an extra option, in order, selected", () => {
		const { select } = renderSetting({ logRetentionDays: 120 });
		expect(options(select())).toEqual(["30 days", "90 days", "120 days", "180 days", "365 days", "Keep forever"]);
		expect(select().value).toBe("120");
	});

	it("places a large stored day count after the standard choices", () => {
		const { select } = renderSetting({ logRetentionDays: 730 });
		expect(options(select()).slice(-2)).toEqual(["730 days", "Keep forever"]);
	});

	it("shows the current usage once it has loaded, and nothing before", async () => {
		renderSetting();
		expect(screen.queryByTestId("log-retention-usage")).toBeNull();
		expect((await screen.findByTestId("log-retention-usage")).textContent).toBe("Now using 3.5 MB for 3 days of history");
	});

	it("shows no usage line and no error when the usage cannot be read", async () => {
		mocks.getLogRetentionUsage.mockRejectedValue(new Error("offline"));
		renderSetting();
		await waitFor(() => expect(mocks.getLogRetentionUsage).toHaveBeenCalled());
		expect(screen.queryByTestId("log-retention-usage")).toBeNull();
	});

	it("reloads the usage when the host announces a saved settings change", async () => {
		renderSetting();
		await screen.findByTestId("log-retention-usage");
		mocks.getLogRetentionUsage.mockResolvedValue({ days: [{ day: "2026-11-01", bytes: 2048 }] });
		await act(async () => {
			window.dispatchEvent(new CustomEvent("rpc:globalSettingsUpdated"));
		});
		await waitFor(() => expect(screen.getByTestId("log-retention-usage").textContent).toBe("Now using 2 KB for 1 day of history"));
	});

	it("asks before lowering with what the host says would go, then saves", async () => {
		const { select, onChange } = renderSetting({ logRetentionDays: 365 });
		await userEvent.selectOptions(select(), "90");
		await waitFor(() => expect(onChange).toHaveBeenCalledWith(90, 365));
		expect(mocks.getLogRetentionUsage).toHaveBeenCalledWith({ retentionDays: 90 });
		expect(mocks.confirm).toHaveBeenCalledWith({
			title: "Delete older history?",
			message: "History older than 90 days will be deleted: 2 days, 1.5 MB. This can't be undone.",
			confirmLabel: "Delete",
			danger: true,
		});
	});

	it("lowers from a non-standard stored value by its real number of days", async () => {
		hostAnswer({ 90: { days: 1, bytes: 10 } });
		const { select, onChange } = renderSetting({ logRetentionDays: 120 });
		await userEvent.selectOptions(select(), "90");
		await waitFor(() => expect(onChange).toHaveBeenCalledWith(90, 120));
		expect(mocks.confirm).toHaveBeenCalledTimes(1);

		onChange.mockClear();
		mocks.confirm.mockClear();
		await userEvent.selectOptions(select(), "180");
		await waitFor(() => expect(onChange).toHaveBeenCalledWith(180, 120));
		expect(mocks.confirm).not.toHaveBeenCalled();
	});

	it("keeps the old value and saves nothing when the confirmation is cancelled", async () => {
		mocks.confirm.mockResolvedValue(false);
		const { select, onChange } = renderSetting({ logRetentionDays: 365 });
		await userEvent.selectOptions(select(), "90");
		await waitFor(() => expect(mocks.confirm).toHaveBeenCalled());
		expect(onChange).not.toHaveBeenCalled();
		await waitFor(() => expect(select()).not.toBeDisabled());
		expect(select().value).toBe("365");
	});

	it("saves without asking when nothing would be deleted", async () => {
		hostAnswer({ 90: { days: 0, bytes: 0 } });
		const { select, onChange } = renderSetting({ logRetentionDays: 365 });
		await userEvent.selectOptions(select(), "90");
		await waitFor(() => expect(onChange).toHaveBeenCalledWith(90, 365));
		expect(mocks.confirm).not.toHaveBeenCalled();
	});

	it("never asks when the retention is raised or set to forever", async () => {
		const { select, onChange } = renderSetting({ logRetentionDays: 90 });
		await userEvent.selectOptions(select(), "365");
		await waitFor(() => expect(onChange).toHaveBeenCalledWith(365, 90));
		await userEvent.selectOptions(select(), "forever");
		await waitFor(() => expect(onChange).toHaveBeenCalledWith("forever", 90));
		expect(mocks.confirm).not.toHaveBeenCalled();
	});

	it("treats going from forever to a number as lowering", async () => {
		const { select, onChange } = renderSetting({ logRetentionDays: "forever" });
		await userEvent.selectOptions(select(), "90");
		await waitFor(() => expect(onChange).toHaveBeenCalledWith(90, "forever"));
		expect(mocks.confirm).toHaveBeenCalledTimes(1);
	});

	it("still asks, without numbers, when the size cannot be read", async () => {
		mocks.getLogRetentionUsage.mockRejectedValue(new Error("offline"));
		const { select, onChange } = renderSetting({ logRetentionDays: 365 });
		await userEvent.selectOptions(select(), "90");
		await waitFor(() => expect(onChange).toHaveBeenCalledWith(90, 365));
		expect(mocks.confirm).toHaveBeenCalledWith(
			expect.objectContaining({ message: "History older than 90 days will be deleted. This can't be undone." }),
		);
	});

	it("disables the select from the change until it is saved, so changes cannot overlap", async () => {
		let finishSave: () => void = () => {};
		const onChange = vi.fn<OnChange>(() => new Promise<void>((resolve) => { finishSave = resolve; }));
		const { select } = renderSetting({ logRetentionDays: 90 }, onChange);
		await userEvent.selectOptions(select(), "365");
		await waitFor(() => expect(select()).toBeDisabled());
		await act(async () => finishSave());
		await waitFor(() => expect(select()).not.toBeDisabled());
	});

	it("before the host settings load, shows no value, offers no choice and shows no usage", async () => {
		const { select, onChange } = renderSetting({ logRetentionDays: "forever" }, vi.fn<OnChange>(async () => {}), false);
		expect(select()).toBeDisabled();
		expect(select().value).toBe("");
		expect(options(select())).toEqual([""]);
		await waitFor(() => expect(mocks.getLogRetentionUsage).toHaveBeenCalled());
		expect(screen.queryByTestId("log-retention-usage")).toBeNull();
		fireEvent.change(select(), { target: { value: "90" } });
		expect(onChange).not.toHaveBeenCalled();
		expect(mocks.confirm).not.toHaveBeenCalled();
	});

	it("shows the host value once the settings have loaded", () => {
		const view = render(
			<I18nProvider>
				<Harness settings={{ logRetentionDays: "forever" }} loaded={false} onChange={vi.fn(async () => {})} />
			</I18nProvider>,
		);
		view.rerender(
			<I18nProvider>
				<Harness settings={{ logRetentionDays: "forever" }} loaded onChange={vi.fn(async () => {})} />
			</I18nProvider>,
		);
		const select = screen.getByTestId("log-retention") as HTMLSelectElement;
		expect(select).not.toBeDisabled();
		expect(select.value).toBe("forever");
	});
});
