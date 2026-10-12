import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ShortcutRow from "../ShortcutRow";
import { shortcutById } from "../../../keymap";
import { setShortcutOverrides } from "../../../keymap-store";
import en from "../../../i18n/translations/en";
import { interpolate } from "../../../i18n/interpolate";
import type { TFunction } from "../../../i18n";

const t = ((key: string, params?: Record<string, string>) => interpolate((en as Record<string, string>)[key] ?? key, params ?? {})) as TFunction;
const realNavigator = globalThis.navigator;

function setPlatform(mac: boolean) {
	Object.defineProperty(globalThis, "navigator", {
		value: mac
			? { platform: "MacIntel", userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" }
			: { platform: "Linux x86_64", userAgent: "Mozilla/5.0 (X11; Linux x86_64)" },
		writable: true,
		configurable: true,
	});
}

function renderRow(id: string) {
	render(<ShortcutRow spec={shortcutById(id)!} t={t} remote onRebind={vi.fn()} onReset={vi.fn()} />);
}

describe("ShortcutRow – browser hint", () => {
	afterEach(() => {
		Object.defineProperty(globalThis, "navigator", { value: realNavigator, writable: true, configurable: true });
	});

	it("names the browser combo when the browser owns the desktop one", () => {
		setPlatform(true);
		renderRow("pane-focus-left");
		expect(screen.getByText("In the browser: ⌥⇧←")).toBeTruthy();
	});

	it("stays quiet when the browser combo is the desktop one", () => {
		setPlatform(false);
		renderRow("pane-focus-left");
		expect(screen.queryByText(/In the browser/)).toBeNull();
	});
});

describe("ShortcutRow – browser hint after a rebind", () => {
	afterEach(() => {
		setShortcutOverrides({});
		Object.defineProperty(globalThis, "navigator", { value: realNavigator, writable: true, configurable: true });
	});

	it("drops the default's browser alternative once the user picks their own combo", () => {
		setPlatform(true);
		setShortcutOverrides({ "pane-focus-left": { primary: "Alt+Mod+BracketLeft" } });
		renderRow("pane-focus-left");
		expect(screen.queryByText(/In the browser/)).toBeNull();
	});
});
