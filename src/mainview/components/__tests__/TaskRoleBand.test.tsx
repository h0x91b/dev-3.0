import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { I18nProvider } from "../../i18n";
import { COORDINATOR_CARD_HALO, TaskRoleBand, TaskRoleChip, taskRole } from "../TaskRoleBand";

describe("taskRole", () => {
	it.each([
		["coordinator", "coordinator"],
		["board-cleanup", "board-cleanup"],
		["pr-review", null],
		[undefined, null],
	] as const)("maps taskType %s to role %s", (taskType, role) => {
		expect(taskRole({ taskType })).toBe(role);
	});
});

describe("TaskRoleBand", () => {
	it("shows no count for a coordinator that created nothing yet", () => {
		render(<I18nProvider><TaskRoleBand role="coordinator" childCount={0} /></I18nProvider>);

		expect(screen.getByTestId("task-role-band")).toHaveTextContent(/coordinator/i);
		expect(screen.queryByTestId("task-role-band-count")).toBeNull();
	});

	it("never counts children on a board-cleanup band", () => {
		render(<I18nProvider><TaskRoleBand role="board-cleanup" childCount={3} /></I18nProvider>);

		expect(screen.queryByTestId("task-role-band-count")).toBeNull();
	});

	it("disables the count when there is nothing to filter by", () => {
		render(<I18nProvider><TaskRoleBand role="coordinator" childCount={2} /></I18nProvider>);

		expect(screen.getByTestId("task-role-band-count")).toBeDisabled();
	});
});

describe("TaskRoleChip", () => {
	it("is a filled chip with a glyph and the role name", () => {
		render(<I18nProvider><TaskRoleChip role="coordinator" testId="chip" /></I18nProvider>);
		const chip = screen.getByTestId("chip");

		expect(chip.className).toContain("bg-accent-fill");
		expect(chip.querySelector("svg")).not.toBeNull();
		expect(chip).toHaveTextContent(/coordinator/i);
	});
});

describe("COORDINATOR_CARD_HALO", () => {
	it("lifts on hover with the shared card-hover shadow, typed so Tailwind emits a box-shadow and not a colour", () => {
		expect(COORDINATOR_CARD_HALO).toMatch(/\bhover:shadow-\[shadow:[^\]]*var\(--shadow-card-hover\)\]/);
	});
});
