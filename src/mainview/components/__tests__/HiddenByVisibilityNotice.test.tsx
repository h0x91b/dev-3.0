import { fireEvent, render, screen } from "@testing-library/react";
import HiddenByVisibilityNotice from "../HiddenByVisibilityNotice";
import { I18nProvider } from "../../i18n";
import type { Task } from "../../../shared/types";
import type { TaskVisibility } from "../../../shared/board-filter-state";

function task(id: string, title: string, status: Task["status"]): Task {
	return { id, seq: 1, projectId: "p1", title, status } as Task;
}

const matches = (t: Task, q: string) => !q.trim() || q.split(" ").every((w) => w.startsWith("status:") ? t.status === w.slice(7) : t.title.includes(w));

const todo = task("a", "alpha", "todo");
const done = task("b", "beta", "completed");
const cancelled = task("c", "beta two", "cancelled");

function renderNotice(props: { visibility?: TaskVisibility; query?: string; tasks?: Task[]; shownCount?: number; onShowAll?: () => void }) {
	const onShowAll = props.onShowAll ?? vi.fn();
	render(
		<I18nProvider>
			<HiddenByVisibilityNotice
				visibility={props.visibility ?? "active"}
				searchQuery={props.query ?? ""}
				tasks={props.tasks ?? [todo, done, cancelled]}
				shownCount={props.shownCount ?? 1}
				matches={matches}
				onShowAll={onShowAll}
			/>
		</I18nProvider>,
	);
	return { onShowAll };
}

describe("HiddenByVisibilityNotice", () => {
	it("shows the count when the search matches only finished tasks", () => {
		renderNotice({ query: "beta", shownCount: 0 });
		const notice = screen.getByRole("status");
		expect(notice).toHaveTextContent("2 finished tasks hidden");
		expect(notice).toHaveTextContent("·");
	});

	it("uses the singular for one hidden task", () => {
		renderNotice({ query: "beta two", shownCount: 0 });
		expect(screen.getByRole("status")).toHaveTextContent("1 finished task hidden");
	});

	it("shows on a board that holds only finished tasks with an empty query", () => {
		renderNotice({ tasks: [done, cancelled], shownCount: 0 });
		expect(screen.getByRole("status")).toHaveTextContent("2 finished tasks hidden");
	});

	it("stays quiet on an ordinary board with an empty query", () => {
		renderNotice({ shownCount: 1 });
		expect(screen.queryByRole("status")).not.toBeInTheDocument();
	});

	it("is hidden under All", () => {
		renderNotice({ visibility: "all", query: "beta", shownCount: 0 });
		expect(screen.queryByRole("status")).not.toBeInTheDocument();
	});

	it("is hidden while the query has a status token", () => {
		renderNotice({ query: "status:completed", shownCount: 1 });
		expect(screen.queryByRole("status")).not.toBeInTheDocument();
	});

	it("is hidden when the query matches visible tasks but no finished ones", () => {
		renderNotice({ query: "alpha", shownCount: 1 });
		expect(screen.queryByRole("status")).not.toBeInTheDocument();
	});

	it("switches to All with Show all", () => {
		const { onShowAll } = renderNotice({ query: "beta", shownCount: 0 });
		fireEvent.click(screen.getByRole("button", { name: "Show all" }));
		expect(onShowAll).toHaveBeenCalledTimes(1);
	});
});
