import { fireEvent, render } from "@testing-library/react";
import ControlMenu from "../ControlMenu";
import { I18nProvider } from "../../i18n";
import { closeTopBackLayer } from "../../back-navigation";

/** Records whether the menu was visible at each focus() into it: focus on a `visibility: hidden` element is a no-op in a browser. */
function recordFocusVisibility(): string[] {
	const seen: string[] = [];
	const original = HTMLElement.prototype.focus;
	vi.spyOn(HTMLElement.prototype, "focus").mockImplementation(function (this: HTMLElement, options?: FocusOptions) {
		const menu = this.closest<HTMLElement>('[role="menu"]');
		if (menu) seen.push(menu.style.visibility);
		original.call(this, options);
	});
	return seen;
}

function renderMenu(onClose = vi.fn()) {
	render(
		<I18nProvider>
			<ControlMenu
				pos={{ top: 10, left: 10 }}
				label="Item"
				onClose={onClose}
				entries={[{ key: "a", label: "First" }, { key: "b", label: "Second" }]}
			/>
		</I18nProvider>,
	);
	return onClose;
}

afterEach(() => vi.restoreAllMocks());

describe("ControlMenu", () => {
	it("moves focus into the menu only once it is visible", () => {
		const seen = recordFocusVisibility();
		renderMenu();
		expect(seen.length).toBeGreaterThan(0);
		expect(seen).not.toContain("hidden");
		expect(document.activeElement?.textContent).toBe("First");
	});

	it("closes on Escape pressed anywhere, through the overlay stack", () => {
		const onClose = renderMenu();
		fireEvent.keyDown(window, { key: "Escape" });
		expect(onClose).toHaveBeenCalled();
	});

	it("closes on the Android Back button", () => {
		const onClose = renderMenu();
		expect(closeTopBackLayer()).toBe(true);
		expect(onClose).toHaveBeenCalled();
	});

	it("draws a danger row in the danger colour", () => {
		render(
			<I18nProvider>
				<ControlMenu pos={{ top: 10, left: 10 }} onClose={vi.fn()} entries={[{ key: "a", label: "Copy" }, { key: "d", label: "Delete", danger: true, separated: true }]} />
			</I18nProvider>,
		);
		const rows = document.querySelectorAll<HTMLElement>('[role="menuitem"]');
		expect(rows[1].className).toContain("text-danger");
		expect(rows[0].className).not.toContain("text-danger");
	});
});
