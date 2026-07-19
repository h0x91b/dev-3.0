import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { TaskPRBadgeInfo } from "../../../shared/types";
import { I18nProvider } from "../../i18n";
import TaskPrStatusPopover from "../TaskPrStatusPopover";

vi.mock("../../rpc", () => ({
	api: { request: { refreshTaskPrStatus: vi.fn() } },
}));

function makePrInfo(overrides: Partial<TaskPRBadgeInfo> = {}): TaskPRBadgeInfo {
	return {
		number: 42,
		url: "https://github.com/acme/widget/pull/42",
		ciStatus: null,
		reviewState: null,
		unresolvedCount: 3,
		...overrides,
	};
}

function renderPopover(props: { onShowUnresolved?: () => void; prInfo?: TaskPRBadgeInfo } = {}) {
	render(
		<I18nProvider>
			<TaskPrStatusPopover
				prInfo={props.prInfo ?? makePrInfo()}
				projectId="p1"
				taskId="t1"
				onShowUnresolved={props.onShowUnresolved}
			>
				<button type="button">PR #42</button>
			</TaskPrStatusPopover>
		</I18nProvider>,
	);
}

describe("TaskPrStatusPopover — unresolved comments row", () => {
	it("renders a plain row when no deep-link handler is provided", async () => {
		renderPopover();
		await userEvent.hover(screen.getByRole("button", { name: "PR #42" }));
		const popover = await screen.findByTestId("pr-status-popover");
		expect(within(popover).getByText("3 unresolved comments")).toBeInTheDocument();
		expect(screen.queryByTestId("pr-popover-unresolved")).not.toBeInTheDocument();
	});

	it("fires the handler and closes the popover when the row is clicked", async () => {
		const onShowUnresolved = vi.fn();
		renderPopover({ onShowUnresolved });
		await userEvent.hover(screen.getByRole("button", { name: "PR #42" }));
		const row = await screen.findByTestId("pr-popover-unresolved");
		expect(row).toHaveTextContent("3 unresolved comments");

		await userEvent.click(row);
		expect(onShowUnresolved).toHaveBeenCalledTimes(1);
		expect(screen.queryByTestId("pr-status-popover")).not.toBeInTheDocument();
	});

	it("shows no unresolved row at all when the count is zero", async () => {
		renderPopover({ prInfo: makePrInfo({ unresolvedCount: 0 }), onShowUnresolved: vi.fn() });
		await userEvent.hover(screen.getByRole("button", { name: "PR #42" }));
		await screen.findByTestId("pr-status-popover");
		expect(screen.queryByTestId("pr-popover-unresolved")).not.toBeInTheDocument();
	});
});
