import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { TaskPRBadgeInfo } from "../../../shared/types";
import { I18nProvider } from "../../i18n";
import TaskPrBadges from "../TaskPrBadges";

vi.mock("../../rpc", () => ({
	api: { request: { refreshTaskPrStatus: vi.fn() } },
}));

function renderBadge(overrides: Partial<TaskPRBadgeInfo>) {
	render(
		<I18nProvider>
			<TaskPrBadges prInfo={{ number: 42, url: "https://github.com/acme/widget/pull/42", ...overrides }} projectId="p1" taskId="t1" />
		</I18nProvider>,
	);
	return screen.getByRole("button", { name: /^Open PR #42/ });
}

const state = (value: string) => ({ mergeable: null, status: null, state: value });

describe("TaskPrBadges — PR number badge follows GitHub's state colours", () => {
	it.each([
		["MERGED", false, "text-pr-merged", "Merged"],
		["CLOSED", false, "text-danger", "Closed"],
		["OPEN", false, "text-success-strong", "Open"],
		["OPEN", true, "text-fg-2", "Draft"],
	] as const)("%s (draft=%s) renders %s and names the state", (value, isDraft, cls, label) => {
		const button = renderBadge({ mergeState: state(value), isDraft });
		expect(button).toHaveClass(cls);
		expect(button).toHaveAccessibleName(`Open PR #42 — ${label}`);
	});

	it("stays neutral and unnamed before anything polled the PR", () => {
		const button = renderBadge({ mergeState: null, isDraft: null });
		expect(button.className).not.toMatch(/success|pr-merged|danger/);
		expect(button).toHaveAccessibleName("Open PR #42");
	});
});

describe("TaskPrBadges - one popover for the whole cluster", () => {
	function rect(left: number, right: number): DOMRect {
		return { left, right, top: 100, bottom: 120, width: right - left, height: 20, x: left, y: 100, toJSON: () => ({}) } as DOMRect;
	}

	it("keeps a single popover open while the pointer moves across the badges", async () => {
		const user = userEvent.setup();
		renderBadge({ mergeState: { mergeable: "MERGEABLE", status: "CLEAN", state: "OPEN" }, unresolvedCount: 2 });

		await user.hover(screen.getByRole("button", { name: /^Open PR #42/ }));
		const popover = await screen.findByTestId("pr-status-popover");
		await user.hover(screen.getByRole("button", { name: /^PR is mergeable/ }));
		await user.hover(screen.getByRole("button", { name: "2 unresolved comments" }));

		expect(screen.getAllByTestId("pr-status-popover")).toHaveLength(1);
		expect(screen.getByTestId("pr-status-popover")).toBe(popover);
	});

	it("places the popover beside the last badge, never over a sibling", async () => {
		const user = userEvent.setup();
		const prButton = renderBadge({ mergeState: { mergeable: "MERGEABLE", status: "CLEAN", state: "OPEN" } });
		const mergeButton = screen.getByRole("button", { name: /^PR is mergeable/ });
		vi.spyOn(prButton, "getBoundingClientRect").mockReturnValue(rect(100, 150));
		vi.spyOn(mergeButton, "getBoundingClientRect").mockReturnValue(rect(154, 230));

		await user.hover(prButton);

		const popover = await screen.findByTestId("pr-status-popover");
		await waitFor(() => expect(popover.style.left).toBe("236px"));
	});
});
