import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nProvider } from "../../i18n";
import SpaceHeaderMenu from "../SpaceHeaderMenu";
import type { Space } from "../../../shared/types";

const space: Space = { id: "sp_a", name: "Labs", parentId: null, projectIds: ["p1"], createdAt: 1 };

function renderMenu(overrides: Partial<Parameters<typeof SpaceHeaderMenu>[0]> = {}) {
	const props = { space, onRename: vi.fn(), onDelete: vi.fn(), ...overrides };
	render(
		<I18nProvider>
			<SpaceHeaderMenu {...props} />
		</I18nProvider>,
	);
	return props;
}

describe("SpaceHeaderMenu", () => {
	it("rests visible and opens the space's two lifecycle actions", async () => {
		const user = userEvent.setup();
		renderMenu();
		const trigger = screen.getByTestId("space-menu-sp_a");
		expect(trigger).toHaveAttribute("aria-expanded", "false");
		await user.click(trigger);
		expect(screen.getByTestId("space-rename-sp_a")).toBeInTheDocument();
		expect(screen.getByTestId("space-delete-sp_a")).toBeInTheDocument();
	});

	it("marks the space hide-on-camera and offers the reverse once it is set", async () => {
		const user = userEvent.setup();
		const props = renderMenu({ onToggleSensitive: vi.fn() });
		await user.click(screen.getByTestId("space-menu-sp_a"));
		const item = screen.getByTestId("space-sensitive-sp_a");
		expect(item).toHaveTextContent("Hide on camera");
		await user.click(item);
		expect(props.onToggleSensitive).toHaveBeenCalledWith(space, true);
	});

	it("offers Show on camera for a space already marked", async () => {
		const user = userEvent.setup();
		const marked = { ...space, sensitive: true };
		const props = renderMenu({ space: marked, onToggleSensitive: vi.fn() });
		await user.click(screen.getByTestId("space-menu-sp_a"));
		await user.click(screen.getByTestId("space-sensitive-sp_a"));
		expect(screen.queryByText("Hide on camera")).not.toBeInTheDocument();
		expect(props.onToggleSensitive).toHaveBeenCalledWith(marked, false);
	});

	it("omits the sensitive toggle where the surface cannot write it", async () => {
		const user = userEvent.setup();
		renderMenu();
		await user.click(screen.getByTestId("space-menu-sp_a"));
		expect(screen.queryByTestId("space-sensitive-sp_a")).not.toBeInTheDocument();
	});

	// A 24px glyph mid-row is unhittable with a thumb and reads as punctuation.
	it("becomes a bordered 44px box at the row's right edge on touch, glyph on a pointer", () => {
		renderMenu({ touchTarget: true });
		const cls = screen.getByTestId("space-menu-sp_a").className;
		expect(cls).toContain("min-h-[44px]");
		expect(cls).toContain("min-w-[44px]");
		expect(cls).toContain("border");
		expect(cls).toContain("ml-auto");
		// …and folds back above md, where the menu sits beside the name.
		expect(cls).toContain("md:border-0");
		expect(cls).toContain("md:ml-0");
	});

	it("keeps the inline glyph where the surface is pointer-only", () => {
		renderMenu();
		const cls = screen.getByTestId("space-menu-sp_a").className;
		expect(cls).not.toContain("min-h-[44px]");
		expect(cls).not.toContain("ml-auto");
	});

	it("renames through an inline field, seeded with the current name", async () => {
		const user = userEvent.setup();
		const props = renderMenu();
		await user.click(screen.getByTestId("space-menu-sp_a"));
		await user.click(screen.getByTestId("space-rename-sp_a"));
		const input = screen.getByTestId("space-rename-input-sp_a") as HTMLInputElement;
		expect(input.value).toBe("Labs");
		await user.clear(input);
		await user.type(input, "Research");
		await user.click(screen.getByTestId("space-rename-save-sp_a"));
		expect(props.onRename).toHaveBeenCalledWith(space, "Research");
	});

	it("commits a rename on Enter", async () => {
		const user = userEvent.setup();
		const props = renderMenu();
		await user.click(screen.getByTestId("space-menu-sp_a"));
		await user.click(screen.getByTestId("space-rename-sp_a"));
		const input = screen.getByTestId("space-rename-input-sp_a");
		await user.clear(input);
		await user.type(input, "Research{Enter}");
		expect(props.onRename).toHaveBeenCalledWith(space, "Research");
	});

	it("ignores an empty or unchanged rename", async () => {
		const user = userEvent.setup();
		const props = renderMenu();
		await user.click(screen.getByTestId("space-menu-sp_a"));
		await user.click(screen.getByTestId("space-rename-sp_a"));
		const input = screen.getByTestId("space-rename-input-sp_a");
		await user.type(input, "{Enter}"); // unchanged
		expect(props.onRename).not.toHaveBeenCalled();

		await user.click(screen.getByTestId("space-menu-sp_a"));
		await user.click(screen.getByTestId("space-rename-sp_a"));
		const again = screen.getByTestId("space-rename-input-sp_a");
		await user.clear(again);
		expect(screen.getByTestId("space-rename-save-sp_a")).toBeDisabled();
	});

	it("asks the host to delete, and closes itself first", async () => {
		const user = userEvent.setup();
		const props = renderMenu();
		await user.click(screen.getByTestId("space-menu-sp_a"));
		await user.click(screen.getByTestId("space-delete-sp_a"));
		expect(props.onDelete).toHaveBeenCalledWith(space);
		expect(screen.queryByTestId("space-delete-sp_a")).not.toBeInTheDocument();
	});

	it("carries the space's order for pointers that cannot drag", async () => {
		const user = userEvent.setup();
		const props = renderMenu({ onMove: vi.fn(), canMoveUp: true, canMoveDown: true });
		await user.click(screen.getByTestId("space-menu-sp_a"));
		await user.click(screen.getByTestId("space-move-down-sp_a"));
		expect(props.onMove).toHaveBeenCalledWith(space, 1);

		await user.click(screen.getByTestId("space-menu-sp_a"));
		await user.click(screen.getByTestId("space-move-up-sp_a"));
		expect(props.onMove).toHaveBeenCalledWith(space, -1);
	});

	it("disables the step that would fall off the end of the order", async () => {
		const user = userEvent.setup();
		renderMenu({ onMove: vi.fn(), canMoveUp: false, canMoveDown: true });
		await user.click(screen.getByTestId("space-menu-sp_a"));
		expect(screen.getByTestId("space-move-up-sp_a")).toBeDisabled();
		expect(screen.getByTestId("space-move-down-sp_a")).toBeEnabled();
	});

	it("omits the order entries entirely when there is nothing to move past", async () => {
		const user = userEvent.setup();
		renderMenu();
		await user.click(screen.getByTestId("space-menu-sp_a"));
		expect(screen.queryByTestId("space-move-up-sp_a")).not.toBeInTheDocument();
		expect(screen.queryByTestId("space-move-down-sp_a")).not.toBeInTheDocument();
	});

	it("styles delete as destructive", async () => {
		const user = userEvent.setup();
		renderMenu();
		await user.click(screen.getByTestId("space-menu-sp_a"));
		expect(screen.getByTestId("space-delete-sp_a").className).toContain("text-danger");
	});
});
