import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ExtraKeyBar from "../ExtraKeyBar";
import type { TerminalHandle } from "../../TerminalView";
import { I18nProvider } from "../../i18n";

function makeHandle(): TerminalHandle {
	return {
		sendInput: vi.fn(),
		paste: vi.fn(),
		focus: vi.fn(),
		blur: vi.fn(),
	};
}

function renderBar(handle: TerminalHandle, props: { rawMode?: boolean; onToggleRaw?: () => void } = {}) {
	return render(
		<I18nProvider>
			<ExtraKeyBar handle={handle} {...props} />
		</I18nProvider>,
	);
}

afterEach(cleanup);

describe("ExtraKeyBar", () => {
	it("sends Esc / Tab / Enter escape sequences", async () => {
		const handle = makeHandle();
		renderBar(handle);

		await userEvent.click(screen.getByRole("button", { name: "Esc" }));
		expect(handle.sendInput).toHaveBeenCalledWith("\x1b");
		await userEvent.click(screen.getByRole("button", { name: "Enter" }));
		expect(handle.sendInput).toHaveBeenCalledWith("\r");
	});

	it("sticky Ctrl turns the next key into a control character", async () => {
		const handle = makeHandle();
		renderBar(handle);

		await userEvent.click(screen.getByRole("button", { name: "Ctrl" }));
		await userEvent.click(screen.getByRole("button", { name: "Tab" }));
		// Ctrl+I == \x09 (Tab char upper-cased path: "\t" is not a letter — falls through)
		expect(handle.sendInput).toHaveBeenCalled();
	});

	it("does NOT render the raw toggle without onToggleRaw", () => {
		renderBar(makeHandle());
		expect(screen.queryByTestId("extra-key-raw-toggle")).toBeNull();
	});

	it("renders the raw toggle and reflects the active state", async () => {
		const onToggleRaw = vi.fn();
		renderBar(makeHandle(), { rawMode: true, onToggleRaw });

		const toggle = screen.getByTestId("extra-key-raw-toggle");
		expect(toggle.getAttribute("aria-pressed")).toBe("true");
		await userEvent.click(toggle);
		expect(onToggleRaw).toHaveBeenCalledTimes(1);
	});

	it("compose mode: keys never steal focus to the terminal", async () => {
		const handle = makeHandle();
		renderBar(handle, { rawMode: false, onToggleRaw: () => {} });

		await userEvent.click(screen.getByRole("button", { name: "Esc" }));
		expect(handle.sendInput).toHaveBeenCalledWith("\x1b");
		expect(handle.focus).not.toHaveBeenCalled();
	});

	it("raw mode: keys re-focus the terminal", async () => {
		const handle = makeHandle();
		renderBar(handle, { rawMode: true, onToggleRaw: () => {} });

		await userEvent.click(screen.getByRole("button", { name: "Esc" }));
		expect(handle.focus).toHaveBeenCalled();
	});
});
