import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import BottomSheet from "../BottomSheet";
import { I18nProvider } from "../../i18n";

function renderSheet(props: Partial<React.ComponentProps<typeof BottomSheet>> = {}) {
	const onClose = props.onClose ?? vi.fn();
	render(
		<I18nProvider>
			<BottomSheet open onClose={onClose} title="Filters" testId="sheet" {...props}>
				<button type="button">Inside</button>
			</BottomSheet>
		</I18nProvider>,
	);
	return { onClose };
}

describe("BottomSheet", () => {
	it("renders nothing when closed", () => {
		render(
			<I18nProvider>
				<BottomSheet open={false} onClose={vi.fn()} title="Filters" testId="sheet">
					<span>Inside</span>
				</BottomSheet>
			</I18nProvider>,
		);
		expect(screen.queryByTestId("sheet")).not.toBeInTheDocument();
	});

	it("renders the title and children when open", () => {
		renderSheet();
		expect(screen.getByText("Filters")).toBeInTheDocument();
		expect(screen.getByText("Inside")).toBeInTheDocument();
	});

	it("moves focus into the sheet on open", () => {
		renderSheet();
		expect(screen.getByRole("dialog")).toHaveFocus();
	});

	it("closes when the backdrop is clicked", async () => {
		const { onClose } = renderSheet();
		await userEvent.click(screen.getByTestId("sheet"));
		expect(onClose).toHaveBeenCalled();
	});

	it("closes via the close button", async () => {
		const { onClose } = renderSheet();
		await userEvent.click(screen.getByLabelText("Close"));
		expect(onClose).toHaveBeenCalled();
	});

	it("closes on Escape", async () => {
		const { onClose } = renderSheet();
		await userEvent.keyboard("{Escape}");
		expect(onClose).toHaveBeenCalled();
	});
});
