import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import PriorityBadge from "../PriorityBadge";
import { I18nProvider } from "../../i18n";

function renderBadge(props: Parameters<typeof PriorityBadge>[0]) {
	return render(
		<I18nProvider>
			<PriorityBadge {...props} />
		</I18nProvider>,
	);
}

describe("PriorityBadge", () => {
	it("renders the P{n} label for the given level", () => {
		renderBadge({ priority: "P0", onChange: vi.fn() });
		expect(screen.getByRole("button", { name: /Priority P0/ })).toHaveTextContent("P0");
	});

	it("falls back to P3 when priority is undefined", () => {
		renderBadge({ priority: undefined, onChange: vi.fn() });
		expect(screen.getByRole("button", { name: /Priority P3/ })).toHaveTextContent("P3");
	});

	it("renders a static, non-interactive chip when onChange is omitted", () => {
		renderBadge({ priority: "P1" });
		expect(screen.queryByRole("button")).not.toBeInTheDocument();
		expect(screen.getByText("P1")).toBeInTheDocument();
	});

	// The narrow summary bar puts the chip beside the status control; a dense chip
	// there read as a stray label, so `touch` has to keep the taller box.
	it("sizes the touch variant to the narrow status control and drops the dense floor opt-out", () => {
		renderBadge({ priority: "P2", onChange: vi.fn(), size: "touch" });
		const btn = screen.getByRole("button", { name: /Priority P2/ });
		expect(btn.className).toContain("min-h-[calc(2.75rem+2px)]");
		expect(btn.className).not.toContain("touch-inline");
	});

	it("keeps the dense sizes opted out of the 44px touch floor", () => {
		renderBadge({ priority: "P2", onChange: vi.fn(), size: "sm" });
		expect(screen.getByRole("button", { name: /Priority P2/ }).className).toContain("touch-inline");
	});

	it("opens the picker and fires onChange with the chosen level", async () => {
		const onChange = vi.fn();
		const user = userEvent.setup();
		renderBadge({ priority: "P2", onChange });

		await user.click(screen.getByRole("button", { name: /Priority P2/ }));

		const menu = await screen.findByRole("menu");
		await user.click(within(menu).getByRole("menuitemradio", { name: /P0/ }));

		expect(onChange).toHaveBeenCalledWith("P0");
	});

	// Portalled to <body>, so it competes with dialogs on z-index alone. Below
	// them it is simply invisible — which is what a z-50 panel was inside the
	// z-[60] agent-launch dialog.
	it("floats the picker above every dialog layer", async () => {
		const user = userEvent.setup();
		renderBadge({ priority: "P2", onChange: vi.fn() });

		await user.click(screen.getByRole("button", { name: /Priority P2/ }));

		expect((await screen.findByRole("menu")).className).toContain("z-[9999]");
	});

	it("does not fire onChange when the current level is re-selected", async () => {
		const onChange = vi.fn();
		const user = userEvent.setup();
		renderBadge({ priority: "P3", onChange });

		await user.click(screen.getByRole("button", { name: /Priority P3/ }));
		const menu = await screen.findByRole("menu");
		// The current level's row is checked.
		const current = within(menu).getByRole("menuitemradio", { name: /P3/ });
		expect(current).toHaveAttribute("aria-checked", "true");
		await user.click(current);

		expect(onChange).not.toHaveBeenCalled();
	});
});
