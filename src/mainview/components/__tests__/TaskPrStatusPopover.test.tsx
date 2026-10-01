import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { TaskPRBadgeInfo, TaskPullRequestRecord } from "../../../shared/types";
import { I18nProvider } from "../../i18n";
import { api } from "../../rpc";
import type { PRDisplayState } from "../../utils/prStateTone";
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

function renderPopover(props: { onShowUnresolved?: () => void; prInfo?: TaskPRBadgeInfo; earlierPullRequests?: TaskPullRequestRecord[]; displayState?: PRDisplayState } = {}) {
	render(
		<I18nProvider>
			<TaskPrStatusPopover
				prInfo={props.prInfo ?? makePrInfo()}
				projectId="p1"
				taskId="t1"
				onShowUnresolved={props.onShowUnresolved}
				earlierPullRequests={props.earlierPullRequests}
				displayState={props.displayState}
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

describe("TaskPrStatusPopover — earlier pull requests", () => {
	it("lists the finished PRs a follow-up replaced, each linking out", async () => {
		renderPopover({
			earlierPullRequests: [
				{ number: 40, url: "https://github.com/acme/widget/pull/40", title: "First try", state: "CLOSED", firstSeenAt: "" },
				{ number: 38, url: "https://github.com/acme/widget/pull/38", title: "Initial change", state: "MERGED", firstSeenAt: "" },
			],
		});
		await userEvent.hover(screen.getByRole("button", { name: "PR #42" }));
		const section = await screen.findByTestId("pr-popover-earlier");

		expect(within(section).getByText("Earlier pull requests")).toBeInTheDocument();
		const links = within(section).getAllByRole("link");
		expect(links.map((link) => link.getAttribute("href"))).toEqual([
			"https://github.com/acme/widget/pull/40",
			"https://github.com/acme/widget/pull/38",
		]);
		expect(within(links[0]).getByText("Closed")).toBeInTheDocument();
		expect(within(links[1]).getByText("Merged")).toBeInTheDocument();
	});

	it("shows no section for a task that only ever had one PR", async () => {
		renderPopover({ earlierPullRequests: [] });
		await userEvent.hover(screen.getByRole("button", { name: "PR #42" }));
		await screen.findByTestId("pr-status-popover");
		expect(screen.queryByTestId("pr-popover-earlier")).not.toBeInTheDocument();
	});
});

describe("TaskPrStatusPopover — PR state colours", () => {
	async function statusValue(prInfo: TaskPRBadgeInfo) {
		renderPopover({ prInfo });
		await userEvent.hover(screen.getByRole("button", { name: "PR #42" }));
		const popover = await screen.findByTestId("pr-status-popover");
		return within(popover).queryByText("PR status")?.nextElementSibling ?? null;
	}
	const state = (value: string) => ({ mergeable: null, status: null, state: value });

	it.each([
		["MERGED", false, "Merged", "text-pr-merged"],
		["CLOSED", false, "Closed", "text-danger"],
		["OPEN", false, "Open", "text-success"],
		["OPEN", true, "Draft", "text-fg-3"],
		["MERGED", true, "Merged", "text-pr-merged"],
	] as const)("%s (draft=%s) shows %s in %s", async (value, isDraft, label, cls) => {
		const dd = await statusValue(makePrInfo({ mergeState: state(value), isDraft }));
		expect(dd).toHaveTextContent(label);
		expect(dd).toHaveClass(cls);
	});

	it("omits the status row when GitHub has not reported a state", async () => {
		expect(await statusValue(makePrInfo({ mergeState: null, isDraft: true }))).toBeNull();
	});

	it("tints earlier PRs by their own state, merged purple and closed red", async () => {
		renderPopover({
			earlierPullRequests: [
				{ number: 40, url: "https://github.com/acme/widget/pull/40", title: "First", state: "CLOSED", firstSeenAt: "" },
				{ number: 38, url: "https://github.com/acme/widget/pull/38", title: "Second", state: "MERGED", firstSeenAt: "" },
			],
		});
		await userEvent.hover(screen.getByRole("button", { name: "PR #42" }));
		const section = await screen.findByTestId("pr-popover-earlier");
		expect(within(section).getByText("Closed")).toHaveClass("text-danger");
		expect(within(section).getByText("Merged")).toHaveClass("text-pr-merged");
	});
});

describe("TaskPrStatusPopover — lifecycle vs mergeability", () => {
	const unknown = (state: string) => ({ mergeable: "UNKNOWN", status: "UNKNOWN", state });

	async function openPopover(props: Parameters<typeof renderPopover>[0]) {
		renderPopover(props);
		await userEvent.hover(screen.getByRole("button", { name: "PR #42" }));
		return screen.findByTestId("pr-status-popover");
	}

	it("merged + UNKNOWN reads as merged, with no Unknown auto-merge or mergeability rows", async () => {
		const popover = await openPopover({ prInfo: makePrInfo({ mergeState: unknown("MERGED"), autoMergeEnabled: null, checks: [] }) });
		expect(within(popover).getByText("PR status").nextElementSibling).toHaveTextContent("Merged");
		expect(within(popover).getByTestId("pr-popover-finished-note")).toHaveTextContent("Merged — auto-merge and mergeability no longer apply.");
		expect(within(popover).queryByText("Auto-merge")).not.toBeInTheDocument();
		expect(within(popover).queryByText("Mergeable")).not.toBeInTheDocument();
		expect(within(popover).queryByText("Unknown")).not.toBeInTheDocument();
		expect(within(popover).getByText("No checks reported")).toBeInTheDocument();
	});

	it("closed + UNKNOWN reads as closed, and a stale CONFLICTING verdict raises no conflict row", async () => {
		const popover = await openPopover({ prInfo: makePrInfo({ mergeState: { mergeable: "CONFLICTING", status: "UNKNOWN", state: "CLOSED" } }) });
		expect(within(popover).getByText("PR status").nextElementSibling).toHaveTextContent("Closed");
		expect(within(popover).getByTestId("pr-popover-finished-note")).toHaveTextContent("Closed without merging");
		expect(within(popover).queryByText("Mergeable")).not.toBeInTheDocument();
		expect(within(popover).queryByText(/merge conflict/i)).not.toBeInTheDocument();
	});

	it("open + UNKNOWN says GitHub is still checking instead of a bare Unknown", async () => {
		const popover = await openPopover({ prInfo: makePrInfo({ mergeState: unknown("OPEN"), autoMergeEnabled: false }) });
		expect(within(popover).getByText("PR status").nextElementSibling).toHaveTextContent("Open");
		expect(within(popover).getByText("Mergeable").nextElementSibling).toHaveTextContent("GitHub is still checking");
		expect(within(popover).getByText("Auto-merge").nextElementSibling).toHaveTextContent("Not set");
		expect(within(popover).queryByTestId("pr-popover-finished-note")).not.toBeInTheDocument();
	});

	it("a PR nothing has polled yet says so instead of Unknown / No checks", async () => {
		const popover = await openPopover({ prInfo: makePrInfo({ mergeState: null, checks: [] }) });
		expect(within(popover).queryByText("Unknown")).not.toBeInTheDocument();
		expect(within(popover).queryByText("No checks reported")).not.toBeInTheDocument();
		expect(within(popover).getAllByText("Not loaded from GitHub yet.")).toHaveLength(2);
	});

	it("takes the lifecycle the badge resolved when prInfo itself carries none", async () => {
		const popover = await openPopover({ prInfo: makePrInfo({ mergeState: null }), displayState: "merged" });
		expect(within(popover).getByText("PR status").nextElementSibling).toHaveTextContent("Merged");
		expect(within(popover).queryByTestId("pr-popover-not-loaded")).not.toBeInTheDocument();
	});

	it("never invents checks for a merged PR", async () => {
		const popover = await openPopover({ prInfo: makePrInfo({ mergeState: unknown("MERGED"), checks: [] }) });
		expect(within(popover).queryByTestId("pr-check-list")).not.toBeInTheDocument();
	});
});

describe("TaskPrStatusPopover — refresh outcome", () => {
	it.each([
		["unavailable", "GitHub didn't answer — showing the last known status."],
		["not-found", "GitHub reports no pull request for this branch."],
	] as const)("a %s refresh says so inside the popover and keeps the last known status", async (outcome, message) => {
		vi.mocked(api.request.refreshTaskPrStatus).mockResolvedValueOnce({ outcome });
		renderPopover({ prInfo: makePrInfo({ mergeState: { mergeable: "UNKNOWN", status: "UNKNOWN", state: "MERGED" } }) });
		await userEvent.hover(screen.getByRole("button", { name: "PR #42" }));
		const popover = await screen.findByTestId("pr-status-popover");
		await userEvent.click(within(popover).getByRole("button", { name: "Refresh PR status" }));

		expect(await within(popover).findByTestId("pr-popover-refresh-notice")).toHaveTextContent(message);
		expect(within(popover).getByText("PR status").nextElementSibling).toHaveTextContent("Merged");
	});

	it("an updated refresh shows no notice", async () => {
		vi.mocked(api.request.refreshTaskPrStatus).mockResolvedValueOnce({ outcome: "updated" });
		renderPopover({ prInfo: makePrInfo({ mergeState: { mergeable: "MERGEABLE", status: "CLEAN", state: "OPEN" } }) });
		await userEvent.hover(screen.getByRole("button", { name: "PR #42" }));
		const popover = await screen.findByTestId("pr-status-popover");
		await userEvent.click(within(popover).getByRole("button", { name: "Refresh PR status" }));
		await vi.waitFor(() => expect(api.request.refreshTaskPrStatus).toHaveBeenCalled());
		expect(within(popover).queryByTestId("pr-popover-refresh-notice")).not.toBeInTheDocument();
	});
});
