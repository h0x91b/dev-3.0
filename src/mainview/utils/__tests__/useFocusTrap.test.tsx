import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { registerOverlayLayer } from "../overlay-layers";
import { useFocusTrap } from "../useFocusTrap";

function Dialog({ empty = false }: { empty?: boolean }) {
	const ref = useFocusTrap<HTMLDivElement>();
	return (
		<div ref={ref} role="dialog" tabIndex={-1}>
			{!empty && (
				<>
					<button>first</button>
					<button>middle</button>
					<button>last</button>
				</>
			)}
		</div>
	);
}

describe("useFocusTrap", () => {
	it("moves focus into the container on mount", () => {
		render(<Dialog />);
		const dialog = screen.getByRole("dialog");
		expect(dialog.contains(document.activeElement)).toBe(true);
	});

	it("Tab from the last focusable wraps to the first", async () => {
		const user = userEvent.setup();
		render(<Dialog />);
		const dialog = screen.getByRole("dialog");

		screen.getByText("last").focus();
		await user.tab();

		expect(document.activeElement).toBe(screen.getByText("first"));
		expect(dialog.contains(document.activeElement)).toBe(true);
	});

	it("Shift+Tab from the first focusable wraps to the last", async () => {
		const user = userEvent.setup();
		render(<Dialog />);

		screen.getByText("first").focus();
		await user.tab({ shift: true });

		expect(document.activeElement).toBe(screen.getByText("last"));
	});

	it("Tab from the container itself goes to the first focusable", async () => {
		const user = userEvent.setup();
		render(<Dialog />);
		const dialog = screen.getByRole("dialog");

		dialog.focus();
		await user.tab();

		expect(document.activeElement).toBe(screen.getByText("first"));
	});

	// Regression: the first Tab after the dialog auto-focuses its container must
	// land on the FIRST focusable (not skip it to the second). The container is
	// focused on mount, so the first forward Tab must not be swallowed.
	it("does not skip the first focusable on the opening Tab", async () => {
		const user = userEvent.setup();
		render(<Dialog />);
		const dialog = screen.getByRole("dialog");
		expect(document.activeElement).toBe(dialog); // auto-focused container

		await user.tab();
		expect(document.activeElement).toBe(screen.getByText("first"));

		await user.tab();
		expect(document.activeElement).toBe(screen.getByText("middle"));
	});

	it("keeps focus from escaping to elements outside the container", async () => {
		const user = userEvent.setup();
		const outside = document.createElement("button");
		outside.textContent = "outside";
		document.body.appendChild(outside);

		render(<Dialog />);
		const dialog = screen.getByRole("dialog");

		for (let i = 0; i < 8; i++) {
			await user.tab();
			expect(dialog.contains(document.activeElement)).toBe(true);
			expect(document.activeElement).not.toBe(outside);
		}

		document.body.removeChild(outside);
	});

	it("does nothing harmful when there are no focusable children", async () => {
		const user = userEvent.setup();
		render(<Dialog empty />);
		const dialog = screen.getByRole("dialog");

		// Container is focused on mount; Tab is swallowed (preventDefault), focus stays put.
		await user.tab();
		expect(document.activeElement).toBe(dialog);
	});

	it("does not steal focus from an autoFocus child", () => {
		function DialogWithInput() {
			const ref = useFocusTrap<HTMLDivElement>();
			return (
				<div ref={ref} role="dialog" tabIndex={-1}>
					<input autoFocus aria-label="name" />
					<button>ok</button>
				</div>
			);
		}
		render(<DialogWithInput />);
		expect(document.activeElement).toBe(screen.getByLabelText("name"));
	});

	it("restores focus to the previously focused element on unmount", () => {
		const trigger = document.createElement("button");
		trigger.textContent = "trigger";
		document.body.appendChild(trigger);
		trigger.focus();
		expect(document.activeElement).toBe(trigger);

		const { unmount } = render(<Dialog />);
		// Focus moved into the dialog.
		expect(document.activeElement).not.toBe(trigger);

		unmount();
		expect(document.activeElement).toBe(trigger);

		document.body.removeChild(trigger);
	});

	// A portalled dropdown / popover is a sibling of the dialog on document.body,
	// so without the overlay-layer stack the trap pulled focus straight back into
	// the dialog and the panel's rows were unreachable by keyboard.
	describe("with an open portalled panel", () => {
		function renderWithPanel(rowsTabbable: boolean) {
			const panel = document.createElement("div");
			panel.innerHTML = rowsTabbable
				? `<button>row one</button><button>row two</button>`
				: `<button tabindex="-1">option one</button><button tabindex="-1">option two</button>`;
			document.body.appendChild(panel);
			const unregister = registerOverlayLayer(panel, () => {});
			const view = render(<Dialog />);
			return {
				panel,
				cleanup: () => {
					unregister();
					view.unmount();
					document.body.removeChild(panel);
				},
			};
		}

		it("pulls the first Tab out of the dialog and into the panel", async () => {
			const user = userEvent.setup();
			const { panel, cleanup } = renderWithPanel(true);

			screen.getByText("middle").focus();
			await user.tab();

			expect(document.activeElement).toBe(screen.getByText("row one"));
			expect(panel.contains(document.activeElement)).toBe(true);
			cleanup();
		});

		it("cycles Tab within the panel instead of the dialog behind it", async () => {
			const user = userEvent.setup();
			const { panel, cleanup } = renderWithPanel(true);

			screen.getByText("row two").focus();
			await user.tab();

			expect(document.activeElement).toBe(screen.getByText("row one"));
			expect(panel.contains(document.activeElement)).toBe(true);
			cleanup();
		});

		it("leaves the dialog ring alone for a roving-focus listbox", async () => {
			// `Select` keeps focus on its trigger and roves with
			// aria-activedescendant, so its rows are tabindex="-1" and must not
			// capture Tab.
			const user = userEvent.setup();
			const { cleanup } = renderWithPanel(false);

			screen.getByText("first").focus();
			await user.tab();

			expect(document.activeElement).toBe(screen.getByText("middle"));
			cleanup();
		});
	});
});
