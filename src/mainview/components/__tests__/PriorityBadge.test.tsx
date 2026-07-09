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

	it("falls back to P2 when priority is undefined", () => {
		renderBadge({ priority: undefined, onChange: vi.fn() });
		expect(screen.getByRole("button", { name: /Priority P2/ })).toHaveTextContent("P2");
	});

	it("renders a static, non-interactive chip when onChange is omitted", () => {
		renderBadge({ priority: "P1" });
		expect(screen.queryByRole("button")).not.toBeInTheDocument();
		expect(screen.getByText("P1")).toBeInTheDocument();
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
