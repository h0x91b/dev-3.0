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

	it("shows the AI agent badge for agent-initiated confirms", async () => {
		renderHost();
		act(() => {
			void confirm({ title: "Agent asks", message: "M", agentInitiated: true });
		});

		expect(await screen.findByText("AI agent request")).toBeInTheDocument();
	});

	it("does not show the AI agent badge for regular confirms", async () => {
		renderHost();
		act(() => {
			void confirm({ title: "Plain", message: "M" });
		});

		await screen.findByText("Plain");
		expect(screen.queryByText("AI agent request")).not.toBeInTheDocument();
	});

	it("focuses the cancel button for agent-initiated confirms", async () => {
		renderHost();
		act(() => {
			void confirm({ title: "Agent asks", message: "M", agentInitiated: true, cancelLabel: "Keep session" });
		});

		const cancelBtn = await screen.findByRole("button", { name: "Keep session" });
		expect(cancelBtn).toHaveFocus();
	});

	it("renders the info subject card with title and body", async () => {
		renderHost();
		act(() => {
			void confirm({
				title: "Agent asks",
				message: "M",
				info: { title: "My important task", body: "Implementing the thing; almost done." },
			});
		});

		expect(await screen.findByText("My important task")).toBeInTheDocument();
		expect(screen.getByText("Implementing the thing; almost done.")).toBeInTheDocument();
	});

	it("renders the info card without a body when body is omitted", async () => {
		renderHost();
		act(() => {
			void confirm({ title: "Agent asks", message: "M", info: { title: "Title only" } });
		});

		expect(await screen.findByText("Title only")).toBeInTheDocument();
	});

	it("resolves false when no host is mounted", async () => {
		// No ConfirmHost rendered → fail-closed.
		await expect(confirm({ title: "T", message: "M" })).resolves.toBe(false);
	});
});
