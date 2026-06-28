import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { I18nProvider } from "../../i18n";
import KeyboardShortcutsModal, { type ShortcutsTab } from "../KeyboardShortcutsModal";

function renderModal(tab: ShortcutsTab = "app") {
	render(
		<I18nProvider>
			<KeyboardShortcutsModal open tab={tab} onTabChange={vi.fn()} onClose={vi.fn()} />
		</I18nProvider>,
	);
}

/** Flip the renderer into browser remote mode (no Electrobun webview id). */
function setRemote() {
	Reflect.deleteProperty(window, "__electrobunWebviewId");
}

describe("KeyboardShortcutsModal — transport awareness", () => {
	beforeEach(() => {
		// Default each test to the Electrobun desktop transport; remote tests opt in
		// via setRemote(). The modal only reads the flag (no rpc import), so faking it
		// here has no transport side effects.
		(window as Window & { __electrobunWebviewId?: number }).__electrobunWebviewId = 1;
	});

	it("desktop (default): shows desktop-only shortcuts and no remote notice", () => {
		renderModal("app");
		// Quit is desktop-only — present on desktop.
		expect(screen.getByText("Quit")).toBeInTheDocument();
		// No remote notice on desktop.
		expect(screen.queryByText(/reserved by your browser/i)).not.toBeInTheDocument();
		// The browser-safe alias is NOT shown on desktop (the ⌘1–9 combo is).
		expect(screen.queryByText("G then 1–9")).not.toBeInTheDocument();
	});

	it("remote: hides desktop-only shortcuts, shows the notice and the aliased combo", () => {
		setRemote();
		renderModal("app");
		// Desktop-only shortcuts are dropped in the browser.
		expect(screen.queryByText("Quit")).not.toBeInTheDocument();
		expect(screen.queryByText("Hide app")).not.toBeInTheDocument();
		// The remote notice is rendered.
		expect(screen.getByText(/reserved by your browser/i)).toBeInTheDocument();
		// switch-project shows its browser-safe alias (kbd), not ⌘1–9.
		expect(screen.getByText("G then 1–9")).toBeInTheDocument();
	});

	it("remote notice does not appear on the Terminal tab", () => {
		setRemote();
		renderModal("terminal");
		expect(screen.queryByText(/reserved by your browser/i)).not.toBeInTheDocument();
	});
});
