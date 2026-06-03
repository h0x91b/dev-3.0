import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConfirmHost, confirm } from "../confirm";
import { I18nProvider } from "../i18n";

function renderHost() {
	return render(
		<I18nProvider>
			<ConfirmHost />
		</I18nProvider>,
	);
}

describe("confirm service", () => {
	it("renders nothing until a confirm is requested", () => {
		renderHost();
		expect(screen.queryByRole("button")).not.toBeInTheDocument();
	});

	it("shows the title and message, and resolves true on confirm", async () => {
		const user = userEvent.setup();
		renderHost();

		let result: Promise<boolean>;
		act(() => {
			result = confirm({ title: "Delete task", message: "Are you sure?" });
		});

		expect(await screen.findByText("Delete task")).toBeInTheDocument();
		expect(screen.getByText("Are you sure?")).toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: "OK" }));

		await expect(result!).resolves.toBe(true);
		// Dialog closes after a choice
		expect(screen.queryByText("Delete task")).not.toBeInTheDocument();
	});

	it("resolves false on cancel", async () => {
		const user = userEvent.setup();
		renderHost();

		let result: Promise<boolean>;
		act(() => {
			result = confirm({ title: "Cancel task", message: "Discard?" });
		});

		await screen.findByText("Cancel task");
		await user.click(screen.getByRole("button", { name: "Cancel" }));

		await expect(result!).resolves.toBe(false);
	});

	it("uses custom labels when provided", async () => {
		renderHost();
		act(() => {
			void confirm({ title: "T", message: "M", confirmLabel: "Yes", cancelLabel: "No" });
		});

		expect(await screen.findByRole("button", { name: "Yes" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "No" })).toBeInTheDocument();
	});

	it("resolves false when no host is mounted", async () => {
		// No ConfirmHost rendered → fail-closed.
		await expect(confirm({ title: "T", message: "M" })).resolves.toBe(false);
	});
});
