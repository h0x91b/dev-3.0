import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Tooltip from "../Tooltip";

// Real timers: the 250ms hover-intent delay is short enough to await for real,
// and fake timers deadlock userEvent's internal waits.

describe("Tooltip", () => {
	it("shows after the hover-intent delay, not immediately", async () => {
		const user = userEvent.setup();
		render(
			<Tooltip content="Do the thing">
				<button>go</button>
			</Tooltip>,
		);
		await user.hover(screen.getByRole("button", { name: "go" }));
		expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
		expect(await screen.findByRole("tooltip")).toHaveTextContent("Do the thing");
	});

	it("hides on unhover and marks the anchor with aria-describedby while open", async () => {
		const user = userEvent.setup();
		render(
			<Tooltip content="Explains">
				<button>go</button>
			</Tooltip>,
		);
		const button = screen.getByRole("button", { name: "go" });
		await user.hover(button);
		const tip = await screen.findByRole("tooltip");
		expect(button).toHaveAttribute("aria-describedby", tip.id);
		await user.unhover(button);
		expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
		expect(button).not.toHaveAttribute("aria-describedby");
	});

	it("renders the kbd chip when provided", async () => {
		const user = userEvent.setup();
		render(
			<Tooltip content="Open palette" kbd="⌘K">
				<button>go</button>
			</Tooltip>,
		);
		await user.hover(screen.getByRole("button", { name: "go" }));
		expect(await screen.findByRole("tooltip")).toHaveTextContent("⌘K");
	});

	it("skips the delay when another tooltip was visible a moment ago (grace period)", async () => {
		const user = userEvent.setup();
		render(
			<>
				<Tooltip content="first">
					<button>one</button>
				</Tooltip>
				<Tooltip content="second">
					<button>two</button>
				</Tooltip>
			</>,
		);
		await user.hover(screen.getByRole("button", { name: "one" }));
		await screen.findByRole("tooltip");
		await user.unhover(screen.getByRole("button", { name: "one" }));
		await user.hover(screen.getByRole("button", { name: "two" }));
		// No waiting — the grace period shows it synchronously.
		expect(screen.getByRole("tooltip")).toHaveTextContent("second");
	});

	it("renders children untouched when disabled", async () => {
		const user = userEvent.setup();
		render(
			<Tooltip content="never" disabled>
				<button>go</button>
			</Tooltip>,
		);
		await user.hover(screen.getByRole("button", { name: "go" }));
		await expect(screen.findByRole("tooltip", {}, { timeout: 400 })).rejects.toThrow();
	});
});
