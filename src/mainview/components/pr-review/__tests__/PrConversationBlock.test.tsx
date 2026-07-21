import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PRReviewThread, TaskPRCommentsPayload } from "../../../../shared/types";
import { I18nProvider } from "../../../i18n";
import { PrConversationBlock, type GithubThreadActions } from "../PrConversationBlock";

function makeThread(overrides: Partial<PRReviewThread> = {}): PRReviewThread {
	return {
		id: "th1",
		path: "src/app.ts",
		line: 1,
		originalLine: 1,
		startLine: null,
		diffSide: "RIGHT",
		isResolved: false,
		isOutdated: false,
		comments: [
			{
				id: "c1",
				author: "alice",
				isBot: false,
				body: "Rename this.",
				createdAt: "2026-07-18T10:00:00Z",
				url: "https://github.com/acme/widget/pull/42#discussion_r1",
			},
		],
		...overrides,
	};
}

function makePayload(overrides: Partial<TaskPRCommentsPayload> = {}): TaskPRCommentsPayload {
	return {
		prNumber: 42,
		prUrl: "https://github.com/acme/widget/pull/42",
		fetchedAt: "2026-07-19T08:00:00Z",
		threads: [makeThread()],
		conversation: [
			{
				id: "ic1",
				author: "codex-bot[bot]",
				isBot: true,
				body: "**LGTM** but check the tests.",
				createdAt: "2026-07-18T11:00:00Z",
				url: "https://github.com/acme/widget/pull/42#issuecomment-1",
			},
		],
		...overrides,
	};
}

const noopActions: GithubThreadActions = {
	exportSelection: {},
	onToggleExport: vi.fn(),
	onSendToAgent: vi.fn(),
	sendStates: {},
};

function renderBlock(props: Partial<Parameters<typeof PrConversationBlock>[0]> = {}) {
	const defaults: Parameters<typeof PrConversationBlock>[0] = {
		payload: makePayload(),
		refreshing: false,
		error: null,
		onRefresh: vi.fn(),
		showResolved: false,
		onToggleShowResolved: vi.fn(),
		unmappedThreads: [],
		threadActions: noopActions,
		diffMode: "branch",
		onSwitchToBranchDiff: vi.fn(),
	};
	const merged = { ...defaults, ...props };
	render(
		<I18nProvider>
			<PrConversationBlock {...merged} />
		</I18nProvider>,
	);
	return merged;
}

describe("PrConversationBlock", () => {
	it("renders nothing without payload, error, or refresh in flight", () => {
		renderBlock({ payload: null });
		expect(screen.queryByTestId("pr-conversation-block")).not.toBeInTheDocument();
	});

	it("shows the title, comment count, and unresolved badge", () => {
		renderBlock();
		const block = screen.getByTestId("pr-conversation-block");
		const toggle = within(block).getByTestId("pr-conversation-toggle");
		expect(within(toggle).getByText("Conversation")).toBeInTheDocument();
		expect(within(toggle).getByText("1 unresolved")).toBeInTheDocument();
		expect(within(toggle).getByText(/Updated/)).toBeInTheDocument();
		expect(toggle).toHaveClass("flex-1");
	});

	it("expands to reveal sanitized markdown conversation comments with a GitHub link", async () => {
		const user = userEvent.setup();
		renderBlock();
		expect(screen.queryByTestId("pr-conversation-list")).not.toBeInTheDocument();

		await user.click(screen.getByTestId("pr-conversation-toggle"));
		const list = screen.getByTestId("pr-conversation-list");
		expect(within(list).getByText("codex-bot[bot]")).toBeInTheDocument();
		expect(within(list).getByText("bot")).toBeInTheDocument();
		expect(within(list).getByText("LGTM").tagName).toBe("STRONG");
		const links = within(list).getAllByRole("link", { name: "Open on GitHub" });
		expect(links[0]).toHaveAttribute("href", "https://github.com/acme/widget/pull/42#issuecomment-1");
	});

	it("shows an empty state when the conversation has no comments", async () => {
		const user = userEvent.setup();
		renderBlock({ payload: makePayload({ conversation: [] }) });
		await user.click(screen.getByTestId("pr-conversation-toggle"));
		expect(screen.getByText("No conversation comments on this pull request.")).toBeInTheDocument();
	});

	it("fires onRefresh from the refresh button", async () => {
		const user = userEvent.setup();
		const { onRefresh } = renderBlock();
		await user.click(screen.getByTestId("pr-comments-refresh"));
		expect(onRefresh).toHaveBeenCalledTimes(1);
		expect(screen.queryByTestId("pr-conversation-list")).not.toBeInTheDocument();
	});

	it("offers the show-resolved toggle only when resolved threads exist", () => {
		renderBlock({ payload: makePayload({ threads: [makeThread()] }) });
		expect(screen.queryByTestId("pr-show-resolved-toggle")).not.toBeInTheDocument();
	});

	it("toggles resolved visibility", async () => {
		const user = userEvent.setup();
		const { onToggleShowResolved } = renderBlock({
			payload: makePayload({ threads: [makeThread(), makeThread({ id: "th2", isResolved: true })] }),
		});
		await user.click(screen.getByTestId("pr-show-resolved-toggle"));
		expect(onToggleShowResolved).toHaveBeenCalledTimes(1);
		expect(screen.queryByTestId("pr-conversation-list")).not.toBeInTheDocument();
	});

	it("renders the error row with a retry action", async () => {
		const user = userEvent.setup();
		const { onRefresh } = renderBlock({ payload: null, error: "gh exploded" });
		expect(screen.getByTestId("pr-comments-error")).toHaveTextContent("gh exploded");
		await user.click(screen.getByRole("button", { name: "Retry" }));
		expect(onRefresh).toHaveBeenCalledTimes(1);
	});

	it("hints to switch modes when threads exist outside branch mode", async () => {
		const user = userEvent.setup();
		const { onSwitchToBranchDiff } = renderBlock({ diffMode: "uncommitted" });
		const hint = screen.getByTestId("pr-threads-mode-hint");
		expect(hint).toHaveTextContent("1 review thread on the PR diff.");
		await user.click(within(hint).getByRole("button", { name: "Open Branch diff" }));
		expect(onSwitchToBranchDiff).toHaveBeenCalledTimes(1);
	});

	it("hides the mode hint in branch mode", () => {
		renderBlock({ diffMode: "branch" });
		expect(screen.queryByTestId("pr-threads-mode-hint")).not.toBeInTheDocument();
	});

	it("renders unmapped threads behind a collapsed group", async () => {
		const user = userEvent.setup();
		renderBlock({
			unmappedThreads: [{ path: "gone/file.ts", threads: [makeThread({ id: "th-gone", path: "gone/file.ts" })] }],
		});
		const group = screen.getByTestId("pr-unmapped-group");
		expect(within(group).queryByTestId("github-thread")).not.toBeInTheDocument();

		await user.click(within(group).getByRole("button", { name: /Threads on files not in this diff/ }));
		expect(within(group).getByTestId("github-thread")).toBeInTheDocument();
		expect(within(group).getByText("gone/file.ts")).toBeInTheDocument();
	});
});
