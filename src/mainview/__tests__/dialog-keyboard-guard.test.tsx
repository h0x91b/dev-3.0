import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfirmHost, confirm } from "../confirm";
import { useEscapeKey } from "../hooks/useEscapeKey";
import { I18nProvider } from "../i18n";
import { setDialogKeyboardGuardClock, UNSOLICITED_DIALOG_QUIET_MS, useDialogKeyboardGuard } from "../utils/dialog-keyboard-guard";
import { isTypingContext } from "../utils/typing-context";

// The regression these guard (seq 2165): an agent's cancellation dialog arrived
// while the user typed a reply, and the next keystroke answered it.

let clock = 0;
const advance = (ms: number) => { clock += ms; };

beforeEach(() => {
	clock = 1_000;
	setDialogKeyboardGuardClock(() => clock);
});
afterEach(() => setDialogKeyboardGuardClock(null));

function renderHost() {
	return render(
		<I18nProvider>
			<textarea data-testid="reply" />
			<ConfirmHost />
		</I18nProvider>,
	);
}

// user-event performs the browser's own default actions — Enter/Space click a
// focused button unless the keydown/keyup was default-prevented.
function setup() {
	return userEvent.setup({ delay: null });
}

async function agentRequest(label = "Cancel task and delete work") {
	let result!: Promise<boolean>;
	act(() => {
		result = confirm({
			title: "Agent requests cancellation",
			message: "M",
			confirmLabel: label,
			cancelLabel: "Keep the task",
			danger: true,
			agentInitiated: true,
		});
	});
	await screen.findByText("Agent requests cancellation");
	let settled: boolean | null = null;
	void result.then((v) => { settled = v; });
	return {
		result,
		get settled() { return settled; },
	};
}

async function flush() {
	await act(async () => { await Promise.resolve(); });
}

describe("dialog keyboard guard — agent request arriving mid-typing", () => {
	it("autofocuses the safe answer, as before", async () => {
		renderHost();
		await agentRequest();
		expect(document.activeElement).toBe(screen.getByRole("button", { name: "Keep the task" }));
	});

	it.each([
		["Space", " "],
		["Enter", "{Enter}"],
		["Escape", "{Escape}"],
		["a sentence", "yes please"],
		["Tab then Enter", "{Tab}{Enter}"],
	])("%s typed right after it opens answers nothing", async (_name, keys) => {
		const user = setup();
		renderHost();
		const req = await agentRequest();
		advance(60);
		await user.keyboard(keys);
		await flush();
		expect(req.settled).toBeNull();
		expect(screen.getByText("Agent requests cancellation")).toBeInTheDocument();
	});

	it("stays unarmed for as long as the user keeps typing", async () => {
		const user = setup();
		renderHost();
		const req = await agentRequest();
		for (let i = 0; i < 20; i++) {
			advance(UNSOLICITED_DIALOG_QUIET_MS - 100);
			await user.keyboard("x");
		}
		advance(UNSOLICITED_DIALOG_QUIET_MS - 100);
		await user.keyboard("{Tab}{Enter}");
		await flush();
		expect(req.settled).toBeNull();
	});

	it("answers deliberate keys once the keyboard has gone quiet: Enter on the focused button", async () => {
		const user = setup();
		renderHost();
		const req = await agentRequest();
		advance(UNSOLICITED_DIALOG_QUIET_MS);
		await user.keyboard("{Enter}");
		await expect(req.result).resolves.toBe(false);
	});

	it("answers deliberate keys once quiet: Tab to the confirm button, then Enter", async () => {
		const user = setup();
		renderHost();
		const req = await agentRequest();
		advance(UNSOLICITED_DIALOG_QUIET_MS);
		await user.keyboard("{Tab}");
		expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel task and delete work" }));
		advance(50);
		await user.keyboard("{Enter}");
		await expect(req.result).resolves.toBe(true);
	});

	it("Escape declines once quiet", async () => {
		const user = setup();
		renderHost();
		const req = await agentRequest();
		advance(UNSOLICITED_DIALOG_QUIET_MS);
		await user.keyboard("{Escape}");
		await expect(req.result).resolves.toBe(false);
	});

	it("Space never presses a dialog button, even once quiet", async () => {
		const user = setup();
		renderHost();
		const req = await agentRequest();
		advance(UNSOLICITED_DIALOG_QUIET_MS);
		await user.keyboard(" ");
		await user.keyboard("{Tab}");
		advance(50);
		await user.keyboard(" ");
		await flush();
		expect(req.settled).toBeNull();
	});

	it("the mouse works at once", async () => {
		const user = setup();
		renderHost();
		const req = await agentRequest();
		await user.click(screen.getByRole("button", { name: "Cancel task and delete work" }));
		await expect(req.result).resolves.toBe(true);
	});

	it("a Space held down before the dialog opened cannot press it on release", async () => {
		const user = setup();
		renderHost();
		await user.click(screen.getByTestId("reply"));
		await user.keyboard("{ >}");
		const req = await agentRequest();
		advance(UNSOLICITED_DIALOG_QUIET_MS + 10);
		await user.keyboard("{/ }");
		await flush();
		expect(req.settled).toBeNull();
	});

	it("auto-repeat of a key held through the opening is swallowed, never left to the browser", async () => {
		renderHost();
		await agentRequest();
		advance(UNSOLICITED_DIALOG_QUIET_MS + 10);
		const focused = document.activeElement!;
		for (const key of ["Enter", " ", "Escape", "Tab"]) {
			const repeat = new KeyboardEvent("keydown", { key, repeat: true, bubbles: true, cancelable: true });
			focused.dispatchEvent(repeat);
			expect(repeat.defaultPrevented, key).toBe(true);
			const up = new KeyboardEvent("keyup", { key, bubbles: true, cancelable: true });
			focused.dispatchEvent(up);
			expect(up.defaultPrevented, key).toBe(true);
		}
		expect(screen.getByText("Agent requests cancellation")).toBeInTheDocument();
	});

	it("one held Enter answers only the first of two stacked dialogs", async () => {
		const user = setup();
		renderHost();
		const first = await agentRequest("Complete task");
		let second!: Promise<boolean>;
		act(() => {
			second = confirm({ title: "Second request", message: "M", confirmLabel: "Cancel task", agentInitiated: true });
		});
		let secondSettled: boolean | null = null;
		void second.then((v) => { secondSettled = v; });
		advance(UNSOLICITED_DIALOG_QUIET_MS);
		await user.keyboard("{Enter>6}");
		await expect(first.result).resolves.toBe(false);
		await screen.findByText("Second request");
		await user.keyboard("{/Enter}");
		await flush();
		expect(secondSettled).toBeNull();
	});

	it("the bare-key shortcut gate treats a focused dialog button as typing", async () => {
		renderHost();
		await agentRequest();
		expect(isTypingContext()).toBe(true);
	});
});

describe("dialog keyboard guard — dialogs the user opened", () => {
	async function userConfirm(keyboardChoice = false) {
		let result!: Promise<boolean>;
		act(() => {
			result = confirm({ title: "Close pane 2?", message: "M", confirmLabel: "Close pane", danger: true, keyboardChoice });
		});
		await screen.findByText("Close pane 2?");
		let settled: boolean | null = null;
		void result.then((v) => { settled = v; });
		return { result, get settled() { return settled; } };
	}

	it("answers Enter and Escape straight away — no quiet window", async () => {
		const user = setup();
		renderHost();
		const a = await userConfirm(true);
		await user.keyboard("{Enter}");
		await expect(a.result).resolves.toBe(true);
		const b = await userConfirm(true);
		await user.keyboard("{Escape}");
		await expect(b.result).resolves.toBe(false);
	});

	it("letters and Space never answer", async () => {
		const user = setup();
		renderHost();
		const a = await userConfirm(true);
		await user.keyboard("yYnN ");
		await user.keyboard("{Tab}");
		await user.keyboard(" ");
		await flush();
		expect(a.settled).toBeNull();
	});

	it("a repeating Enter from the opening gesture does not confirm", async () => {
		renderHost();
		const a = await userConfirm(true);
		act(() => {
			for (let i = 0; i < 5; i++) {
				window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", repeat: true, bubbles: true, cancelable: true }));
			}
		});
		await flush();
		expect(a.settled).toBeNull();
	});

	it("an IME composition's Enter does not confirm", async () => {
		renderHost();
		const a = await userConfirm(true);
		act(() => {
			window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true, cancelable: true }));
		});
		await flush();
		expect(a.settled).toBeNull();
	});

	it("Escape closes the confirm on top, not the overlay underneath", async () => {
		const user = setup();
		let outerClosed = false;
		function Outer() {
			useEscapeKey(() => { outerClosed = true; });
			return null;
		}
		render(
			<I18nProvider>
				<Outer />
				<ConfirmHost />
			</I18nProvider>,
		);
		const a = await userConfirm();
		await user.keyboard("{Escape}");
		await expect(a.result).resolves.toBe(false);
		expect(outerClosed).toBe(false);
	});
});

describe("dialog keyboard guard — text entry inside a guarded dialog", () => {
	function Form({ onSubmit }: { onSubmit: () => void }) {
		const ref = useRef<HTMLDivElement>(null);
		useDialogKeyboardGuard(ref);
		return (
			<div ref={ref} role="dialog" aria-modal="true">
				<textarea data-testid="field" />
				<button type="button" onClick={onSubmit}>Submit</button>
			</div>
		);
	}

	it("keeps typing, spaces and held keys working in a field", async () => {
		const user = setup();
		render(<Form onSubmit={() => {}} />);
		await user.click(screen.getByTestId("field"));
		await user.keyboard("hello world{ >3/}x");
		expect(screen.getByTestId("field")).toHaveValue("hello world   x");
	});

	it("keeps Tab moving focus", async () => {
		const user = setup();
		render(<Form onSubmit={() => {}} />);
		await user.click(screen.getByTestId("field"));
		await user.keyboard("{Tab}");
		expect(document.activeElement).toBe(screen.getByRole("button", { name: "Submit" }));
	});
});
