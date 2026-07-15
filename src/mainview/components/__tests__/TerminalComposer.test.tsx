import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import TerminalComposer from "../TerminalComposer";
import type { TerminalHandle } from "../../TerminalView";
import { I18nProvider } from "../../i18n";

let restoreVisualViewport: (() => void) | undefined;

function installVisualViewport(initialHeight: number) {
	let height = initialHeight;
	const viewport = new EventTarget() as VisualViewport;
	const descriptor = Object.getOwnPropertyDescriptor(window, "visualViewport");
	Object.defineProperty(viewport, "height", {
		configurable: true,
		get: () => height,
	});
	Object.defineProperty(window, "visualViewport", {
		configurable: true,
		value: viewport,
	});
	restoreVisualViewport = () => {
		if (descriptor) Object.defineProperty(window, "visualViewport", descriptor);
		else Reflect.deleteProperty(window, "visualViewport");
	};

	return {
		resize(nextHeight: number) {
			height = nextHeight;
			viewport.dispatchEvent(new Event("resize"));
		},
	};
}

function makeHandle(): TerminalHandle {
	return {
		sendInput: vi.fn(),
		paste: vi.fn(),
		submit: vi.fn(),
		focus: vi.fn(),
		blur: vi.fn(),
	};
}

function renderComposer(handle: TerminalHandle) {
	return render(
		<I18nProvider>
			<TerminalComposer handle={handle} />
		</I18nProvider>,
	);
}

afterEach(() => {
	cleanup();
	restoreVisualViewport?.();
	restoreVisualViewport = undefined;
	delete document.documentElement.dataset.composerFocused;
});

describe("TerminalComposer", () => {
	it("uses the terminal submit transport and clears the input", async () => {
		const handle = makeHandle();
		renderComposer(handle);
		const input = screen.getByTestId("terminal-composer-input") as HTMLTextAreaElement;

		await userEvent.type(input, "run the tests");
		await userEvent.click(screen.getByRole("button", { name: /send/i }));

		expect(handle.submit).toHaveBeenCalledWith("run the tests");
		expect(handle.paste).not.toHaveBeenCalled();
		expect(handle.sendInput).not.toHaveBeenCalled();
		expect(input.value).toBe("");
	});

	it("Insert pastes without Enter", async () => {
		const handle = makeHandle();
		renderComposer(handle);
		const input = screen.getByTestId("terminal-composer-input") as HTMLTextAreaElement;

		await userEvent.type(input, "partial command");
		await userEvent.click(screen.getByRole("button", { name: /insert without enter/i }));

		expect(handle.paste).toHaveBeenCalledWith("partial command");
		expect(handle.sendInput).not.toHaveBeenCalled();
		expect(input.value).toBe("");
	});

	it("Send is disabled while the input is empty", () => {
		const handle = makeHandle();
		renderComposer(handle);

		expect(screen.getByRole("button", { name: /send/i })).toBeDisabled();
		expect(screen.getByRole("button", { name: /insert without enter/i })).toBeDisabled();
	});

	it("Ctrl+Enter sends; plain Enter stays a newline", async () => {
		const handle = makeHandle();
		renderComposer(handle);
		const input = screen.getByTestId("terminal-composer-input") as HTMLTextAreaElement;

		await userEvent.type(input, "line one");
		await userEvent.keyboard("{Enter}");
		expect(handle.paste).not.toHaveBeenCalled();
		expect(input.value).toBe("line one\n");

		await userEvent.keyboard("{Control>}{Enter}{/Control}");
		expect(handle.submit).toHaveBeenCalledWith("line one\n");
		expect(handle.paste).not.toHaveBeenCalled();
		expect(handle.sendInput).not.toHaveBeenCalled();
	});

	it("marks <html data-composer-focused> while focused and clears it on blur", async () => {
		const handle = makeHandle();
		renderComposer(handle);
		const input = screen.getByTestId("terminal-composer-input");

		await userEvent.click(input);
		expect(document.documentElement.dataset.composerFocused).toBe("true");

		(input as HTMLTextAreaElement).blur();
		expect(document.documentElement.dataset.composerFocused).toBeUndefined();
	});

	it("restores chrome when Android closes the keyboard without blurring the textarea", async () => {
		const viewport = installVisualViewport(900);
		const handle = makeHandle();
		renderComposer(handle);
		const input = screen.getByTestId("terminal-composer-input");

		await userEvent.click(input);
		viewport.resize(450);
		expect(document.documentElement.dataset.composerFocused).toBe("true");

		viewport.resize(900);
		expect(document.activeElement).toBe(input);
		expect(document.documentElement.dataset.composerFocused).toBeUndefined();
	});

	it("clears the focus marker on unmount", async () => {
		const handle = makeHandle();
		const { unmount } = renderComposer(handle);
		await userEvent.click(screen.getByTestId("terminal-composer-input"));
		expect(document.documentElement.dataset.composerFocused).toBe("true");

		unmount();
		expect(document.documentElement.dataset.composerFocused).toBeUndefined();
	});

	it("expand toggles the full-surface editor and keeps the same textarea element", async () => {
		const handle = makeHandle();
		renderComposer(handle);
		const input = screen.getByTestId("terminal-composer-input");
		const before = input;

		await userEvent.click(screen.getByRole("button", { name: /expand editor/i }));
		expect(screen.getByTestId("terminal-composer").className).toContain("absolute");
		// Same DOM node — focus (and the mobile keyboard) survives the flip.
		expect(screen.getByTestId("terminal-composer-input")).toBe(before);

		await userEvent.click(screen.getByRole("button", { name: /collapse editor/i }));
		expect(screen.getByTestId("terminal-composer").className).not.toContain("absolute");
	});

	it("sending from expanded mode collapses back to the bar", async () => {
		const handle = makeHandle();
		renderComposer(handle);
		await userEvent.type(screen.getByTestId("terminal-composer-input"), "long prompt");
		await userEvent.click(screen.getByRole("button", { name: /expand editor/i }));
		await userEvent.click(screen.getByRole("button", { name: /send/i }));

		expect(handle.submit).toHaveBeenCalledWith("long prompt");
		expect(screen.getByTestId("terminal-composer").className).not.toContain("absolute");
	});
});
