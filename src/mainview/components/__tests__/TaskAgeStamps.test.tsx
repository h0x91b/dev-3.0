import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import TaskAgeStamps from "../TaskAgeStamps";
import { I18nProvider } from "../../i18n";

const NOW = new Date("2026-11-07T12:00:00.000Z").getTime();
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function renderStamps(task: { createdAt: string; movedAt?: string }, fit?: "both" | "activity" | "none") {
	return render(
		<I18nProvider>
			<TaskAgeStamps task={task} now={NOW} testId="age" fit={fit} />
		</I18nProvider>,
	);
}

describe("TaskAgeStamps", () => {
	it("shows the creation age and the time since the last status change", () => {
		renderStamps({ createdAt: ago(6 * DAY), movedAt: ago(37 * 1000) });
		expect(screen.getByTestId("age-created")).toHaveTextContent("6d");
		expect(screen.getByTestId("age-activity")).toHaveTextContent("37s");
	});

	it("uses the creation time as the last activity of a task that never moved", () => {
		renderStamps({ createdAt: ago(45 * DAY) });
		const activity = screen.getByTestId("age-activity");
		expect(activity).toHaveTextContent("1mo");
		expect(activity).toHaveTextContent("In this column since it was created");
	});

	it.each([
		[5 * MIN, "live", "text-accent"],
		[30 * MIN, "recent", "text-accent/70"],
		[5 * HOUR, "today", "text-fg-2"],
		[3 * DAY, "stale", "text-fg-muted"],
	])("colours activity %ims ago as %s", (elapsed, tier, className) => {
		renderStamps({ createdAt: ago(10 * DAY), movedAt: ago(elapsed) });
		const activity = screen.getByTestId("age-activity");
		expect(activity).toHaveAttribute("data-freshness", tier);
		expect(activity.className.split(" ")).toContain(className);
	});

	it("keeps the creation stamp muted whatever its age", () => {
		renderStamps({ createdAt: ago(MIN), movedAt: ago(MIN) });
		expect(screen.getByTestId("age-created").className.split(" ")).toContain("text-fg-muted");
	});

	it("names both clocks in their tooltips", async () => {
		const user = userEvent.setup();
		renderStamps({ createdAt: ago(6 * DAY), movedAt: ago(2 * HOUR) });
		await user.hover(screen.getByTestId("age-created"));
		expect(await screen.findByRole("tooltip")).toHaveTextContent("Created 6d ago");
		await user.unhover(screen.getByTestId("age-created"));
		await user.hover(screen.getByTestId("age-activity"));
		expect(await screen.findByRole("tooltip")).toHaveTextContent("Status changed 2h ago");
	});

	it("drops the creation stamp first, then both, as the header runs out of room", () => {
		const { rerender } = renderStamps({ createdAt: ago(DAY), movedAt: ago(MIN) }, "activity");
		expect(screen.queryByTestId("age-created")).not.toBeInTheDocument();
		expect(screen.getByTestId("age-activity")).toBeInTheDocument();
		rerender(
			<I18nProvider>
				<TaskAgeStamps task={{ createdAt: ago(DAY), movedAt: ago(MIN) }} now={NOW} testId="age" fit="none" />
			</I18nProvider>,
		);
		expect(screen.queryByTestId("age")).not.toBeInTheDocument();
	});
});
