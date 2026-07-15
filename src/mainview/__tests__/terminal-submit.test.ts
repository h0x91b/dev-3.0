import { describe, expect, it, vi } from "vitest";
import { submitPastedText, UNBRACKETED_PASTE_SETTLE_DELAY_MS } from "../terminal-submit";

function makeTransport(hasBracketedPaste: boolean) {
	return {
		paste: vi.fn(),
		sendInput: vi.fn(),
		hasBracketedPaste: vi.fn(() => hasBracketedPaste),
	};
}

describe("submitPastedText", () => {
	it("submits immediately after an explicit bracketed paste", () => {
		const transport = makeTransport(true);
		const schedule = vi.fn();

		submitPastedText("run the tests", transport, schedule);

		expect(transport.paste).toHaveBeenCalledWith("run the tests");
		expect(transport.sendInput).toHaveBeenCalledWith("\r");
		expect(schedule).not.toHaveBeenCalled();
	});

	it("waits past Codex's paste-burst window before submitting raw paste", () => {
		const transport = makeTransport(false);
		let scheduledSubmit: (() => void) | undefined;
		let delayMs = 0;
		const schedule = vi.fn((callback: () => void, delay: number) => {
			scheduledSubmit = callback;
			delayMs = delay;
		});

		submitPastedText("run the tests", transport, schedule);

		expect(transport.paste).toHaveBeenCalledWith("run the tests");
		expect(transport.sendInput).not.toHaveBeenCalled();
		expect(delayMs).toBe(UNBRACKETED_PASTE_SETTLE_DELAY_MS);
		expect(delayMs).toBeGreaterThan(120);

		scheduledSubmit?.();
		expect(transport.sendInput).toHaveBeenCalledTimes(1);
		expect(transport.sendInput).toHaveBeenCalledWith("\r");
	});

	it("uses the safe delayed path when the terminal mode query throws", () => {
		const transport = makeTransport(true);
		transport.hasBracketedPaste.mockImplementation(() => {
			throw new Error("disposed");
		});
		const schedule = vi.fn();

		submitPastedText("prompt", transport, schedule);

		expect(transport.sendInput).not.toHaveBeenCalled();
		expect(schedule).toHaveBeenCalledWith(expect.any(Function), UNBRACKETED_PASTE_SETTLE_DELAY_MS);
	});

	it("does not press Enter when paste itself fails", () => {
		const transport = makeTransport(true);
		transport.paste.mockImplementation(() => {
			throw new Error("disposed");
		});
		const schedule = vi.fn();

		submitPastedText("prompt", transport, schedule);

		expect(transport.sendInput).not.toHaveBeenCalled();
		expect(schedule).not.toHaveBeenCalled();
	});
});
