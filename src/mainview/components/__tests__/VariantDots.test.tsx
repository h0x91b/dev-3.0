import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Task } from "../../../shared/types";
import { STATUS_COLORS } from "../../../shared/types";
import { I18nProvider } from "../../i18n";
import VariantDots from "../VariantDots";

function makeVariant(id: string, variantIndex: number, status: Task["status"] = "in-progress"): Task {
	return {
		id,
		seq: variantIndex,
		projectId: "p1",
		title: `Variant ${variantIndex}`,
		description: `Variant ${variantIndex}`,
		status,
		baseBranch: "main",
		worktreePath: `/tmp/${id}`,
		branchName: `dev3/${id}`,
		groupId: "group-1",
		variantIndex,
		agentId: null,
		configId: null,
		createdAt: "2025-01-01T00:00:00Z",
		updatedAt: "2025-01-01T00:00:00Z",
	};
}

function renderDots(variants: Task[], currentTaskId = "v5", onParentClick = vi.fn()) {
	return render(
		<I18nProvider>
			<div onClick={onParentClick}>
				<VariantDots
					groupMembers={variants}
					currentTaskId={currentTaskId}
					statusColors={STATUS_COLORS}
					agents={[]}
					navigate={vi.fn()}
					projectId="p1"
					testId="variant-dots"
				/>
			</div>
		</I18nProvider>,
	);
}

describe("VariantDots", () => {
	it("caps the cluster at three dots and always includes the current variant", () => {
		renderDots([
			makeVariant("v1", 1),
			makeVariant("v2", 2),
			makeVariant("v3", 3),
			makeVariant("v4", 4),
			makeVariant("v5", 5),
		]);

		expect(screen.getAllByTestId(/^variant-dots-dot-/)).toHaveLength(3);
		expect(screen.getByTestId("variant-dots-dot-v5")).toBeInTheDocument();
		expect(screen.getByTestId("variant-dots-dot-v5")).toHaveClass("ring-1");
	});

	it("opens the sibling overview without activating the card", async () => {
		const parentClick = vi.fn();
		renderDots([makeVariant("v1", 1), makeVariant("v2", 2)], "v1", parentClick);

		await userEvent.click(screen.getByTestId("variant-dots"));

		expect(parentClick).not.toHaveBeenCalled();
		expect(screen.getByRole("dialog", { name: "Siblings" })).toBeInTheDocument();
	});

	it("renders nothing for a singleton group", () => {
		renderDots([makeVariant("v1", 1)], "v1");

		expect(screen.queryByTestId("variant-dots")).not.toBeInTheDocument();
	});
});
