import { act, render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nProvider } from "../i18n";
import TrafficPeriodPicker from "../components/agent-traffic/TrafficPeriodPicker";
import {
	isCalendarDay,
	localDay,
	shiftDay,
	trafficPeriodBounds,
} from "../components/agent-traffic/traffic-period";

it("calendar days run from local midnight to next midnight, while 24h stays rolling", () => {
	const now = new Date(2026, 8, 7, 15, 30).getTime();
	const bounds = trafficPeriodBounds("2026-09-06", now);
	expect(bounds.start).toBe(new Date(2026, 8, 6).getTime());
	expect(bounds.end).toBe(new Date(2026, 8, 7).getTime());
	expect(trafficPeriodBounds("day", now).start).toBe(now - 86400000);
	expect(shiftDay("2026-03-01", -1)).toBe("2026-02-28");
	expect(shiftDay("2024-03-01", -1)).toBe("2024-02-29");
	expect(isCalendarDay("2026-02-30")).toBe(false);
	for (const day of ["2026-03-08", "2026-10-25", "2026-11-01"]) {
		const interval = trafficPeriodBounds(day, now);
		expect(localDay(new Date(interval.start))).toBe(day);
		expect(localDay(new Date(interval.end))).toBe(shiftDay(day, 1));
		expect(new Date(interval.end).getHours()).toBe(0);
	}
});

it("opens a themed calendar and chooses yesterday without a native dialog", async () => {
	const onChange = vi.fn();
	render(
		<I18nProvider>
			<TrafficPeriodPicker value="day" onChange={onChange} retentionDays={30} />
		</I18nProvider>,
	);
	const trigger = screen.getByRole("button", {
		name: "Time window: Last 24 hours",
	});
	await userEvent.click(trigger);
	expect(screen.getByRole("dialog", { name: "Choose date" })).toBeTruthy();
	await userEvent.click(screen.getByRole("button", { name: "Yesterday" }));
	expect(onChange).toHaveBeenCalledWith(shiftDay(localDay(new Date()), -1));
	expect(screen.queryByRole("dialog")).toBeNull();
	expect(document.activeElement).toBe(trigger);
});

it("keyboard navigation crosses month boundaries and cannot move into the future", async () => {
	const today = localDay(new Date());
	const first = `${today.slice(0, 7)}-01`;
	const onChange = vi.fn();
	render(
		<I18nProvider>
			<TrafficPeriodPicker
				value={first}
				onChange={onChange}
				retentionDays={60}
			/>
		</I18nProvider>,
	);
	await userEvent.click(screen.getByRole("button", { name: /^Time window:/ }));
	const calendar = screen.getByRole("group", { name: "Choose date" });
	const day = calendar.querySelector<HTMLButtonElement>(
		`[data-day="${first}"]`,
	)!;
	act(() => day.focus());
	fireEvent.keyDown(day, { key: "ArrowLeft" });
	expect(
		calendar.querySelector(`[data-day="${shiftDay(first, -1)}"]`),
	).toBeTruthy();
	const month = screen.getByRole("button", { name: "Next month" });
	await userEvent.click(month);
	expect(month).toBeDisabled();
	const todayButton = calendar.querySelector<HTMLButtonElement>(
		`[data-day="${today}"]`,
	)!;
	act(() => todayButton.focus());
	fireEvent.keyDown(todayButton, { key: "ArrowRight" });
	expect(todayButton.tabIndex).toBe(0);
	const tomorrow = calendar.querySelector<HTMLButtonElement>(
		`[data-day="${shiftDay(today, 1)}"]`,
	);
	if (tomorrow) expect(tomorrow).toBeDisabled();
	await userEvent.click(todayButton);
	expect(onChange).toHaveBeenCalledWith(today);
});
