import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
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
