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

	it("renders and resolves a neutral alternative action", async () => {
		const user = userEvent.setup();
		renderHost();
		let result: Promise<boolean | string>;
		act(() => {
			result = confirm({
				title: "Branch Merged",
				message: "Choose what to do",
				confirmLabel: "Complete task",
				cancelLabel: "Not now",
				alternativeAction: { label: "Manual completion", value: "manual" },
			});
		});

		expect(await screen.findByRole("button", { name: "Manual completion" })).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "Manual completion" }));
		await expect(result!).resolves.toBe("manual");
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

	it("renders the task identity row: seq, project, priority and labels", async () => {
		renderHost();
		act(() => {
			void confirm({
				title: "Agent asks",
				message: "M",
				info: {
					title: "My important task",
					body: "Almost done.",
					seqLabel: "1159",
					projectName: "dev-3.0",
					priority: "P1",
					labels: [
						{ id: "l1", name: "Feature", color: "#84cc16" },
						{ id: "l2", name: "Polish", color: "#64748b" },
					],
				},
			});
		});

		expect(await screen.findByText("#1159")).toBeInTheDocument();
		expect(screen.getByText("dev-3.0")).toBeInTheDocument();
		expect(screen.getByText("P1")).toBeInTheDocument();
		expect(screen.getByText("Feature")).toBeInTheDocument();
		expect(screen.getByText("Polish")).toBeInTheDocument();
	});

	it("omits the identity row when only a title is given", async () => {
		renderHost();
		act(() => {
			void confirm({ title: "Agent asks", message: "M", info: { title: "Just a title" } });
		});

		await screen.findByText("Just a title");
		// No seq badge means no leading-# metadata line rendered.
		expect(screen.queryByText(/^#/)).not.toBeInTheDocument();
	});

	it("traps focus inside the dialog (Tab does not escape)", async () => {
		const user = userEvent.setup();
		const outside = document.createElement("button");
		outside.textContent = "outside";
		document.body.appendChild(outside);

		renderHost();
		act(() => {
			void confirm({ title: "Trap me", message: "M" });
		});

		const dialog = await screen.findByRole("dialog");
		expect(dialog.contains(document.activeElement)).toBe(true);

		for (let i = 0; i < 6; i++) {
			await user.tab();
			expect(dialog.contains(document.activeElement)).toBe(true);
			expect(document.activeElement).not.toBe(outside);
		}

		document.body.removeChild(outside);
	});

	it("resolves false when no host is mounted", async () => {
		// No ConfirmHost rendered → fail-closed.
		await expect(confirm({ title: "T", message: "M" })).resolves.toBe(false);
	});

	it("closes and resolves false when the abort signal fires", async () => {
		renderHost();
		const controller = new AbortController();

		let result: Promise<boolean>;
		act(() => {
			result = confirm({ title: "Branch Merged", message: "Complete?", signal: controller.signal });
		});

		expect(await screen.findByText("Branch Merged")).toBeInTheDocument();

		act(() => {
			controller.abort();
		});

		await expect(result!).resolves.toBe(false);
		expect(screen.queryByText("Branch Merged")).not.toBeInTheDocument();
	});

	it("closes immediately when the signal is already aborted", async () => {
		renderHost();
		const controller = new AbortController();
		controller.abort();

		let result: Promise<boolean>;
		act(() => {
			result = confirm({ title: "Already resolved", message: "x", signal: controller.signal });
		});

		await expect(result!).resolves.toBe(false);
		expect(screen.queryByText("Already resolved")).not.toBeInTheDocument();
	});
});
