import { KANBAN_VIEW_ID } from "../../../shared/board-view-state";
import { TOGGLEABLE_BUILTIN_VIEWS } from "../../../shared/extensions";
import { BUILTIN_BOARD_VIEWS } from "../builtins";

vi.mock("../../rpc", () => ({ api: { request: {} } }));

describe("BUILTIN_BOARD_VIEWS", () => {
	it("marks Kanban, the fallback view, as required so it always runs (D16)", () => {
		expect(BUILTIN_BOARD_VIEWS.find((view) => view.id === KANBAN_VIEW_ID)?.required).toBe(true);
	});

	it("makes exactly the views the user cannot toggle required", () => {
		const required = BUILTIN_BOARD_VIEWS.filter((view) => view.required).map((view) => view.id);
		const untoggleable = BUILTIN_BOARD_VIEWS.map((view) => view.id).filter((id) => !(TOGGLEABLE_BUILTIN_VIEWS as readonly string[]).includes(id));
		expect(required).toEqual(untoggleable);
	});
});
