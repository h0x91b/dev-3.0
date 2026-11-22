import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { MockInstance } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Context } from "cordis";
import { DEFAULT_EXTERNAL_APPS, type ExternalApp } from "../../../shared/types";
import OpenInMenu from "../../components/OpenInMenu";
import { invalidateAvailableApps } from "../../hooks/useAvailableApps";
import { I18nProvider } from "../../i18n";
import { api } from "../../rpc";
import { getAppRoot } from "../../plugins/root";
import { resetPluginsForTests } from "../../plugins/runtime";
import { getOpenInTargetRegistry, type OpenInTarget } from "../registry";
import { BUILTIN_OPEN_IN_TARGETS } from "../builtins";
import { OPEN_IN_ICON_FALLBACK, placeOpenInRows, resetOpenInTargetFailuresForTests } from "../rows";
import { installOpenInTargetBuiltins } from "./install-builtins";

vi.mock("../../rpc", () => ({
	api: { request: { getAvailableApps: vi.fn(), openInApp: vi.fn().mockResolvedValue(undefined) } },
}));

const custom: ExternalApp[] = [
	{ id: "custom-fork", name: "Fork", macAppName: "Fork" },
	{ id: "my-editor", name: "My Editor", macAppName: "My Editor" },
];

async function settle(): Promise<void> {
	for (let tick = 0; tick < 50; tick++) await act(async () => {});
}

function contribute(target: OpenInTarget) {
	return getAppRoot().plugin({ name: "open-in-probe", inject: ["openInTargets"], apply: (ctx: Context) => void ctx.openInTargets.register(target) });
}

function renderMenu() {
	render(
		<I18nProvider>
			<OpenInMenu position={{ top: 0, left: 0 }} path="/tmp/wt" onClose={vi.fn()} />
		</I18nProvider>,
	);
}

let errors: MockInstance<typeof console.error>;

beforeEach(() => {
	resetPluginsForTests();
	resetOpenInTargetFailuresForTests();
	invalidateAvailableApps();
	vi.clearAllMocks();
	errors = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => vi.restoreAllMocks());

describe("openInTargets slot", () => {
	// Taken from main's openInAppIcons.ts before the move: same glyphs, brand colours and categories.
	it("draws every default and user-added app exactly as before the slot", async () => {
		await installOpenInTargetBuiltins();
		const before = JSON.parse(readFileSync(join(__dirname, "__snapshots__", "open-in-rows.json"), "utf8"));
		const rows = placeOpenInRows([...DEFAULT_EXTERNAL_APPS, ...custom], getOpenInTargetRegistry().list());
		expect(rows.map((row) => ({
			appId: row.appId,
			name: row.name,
			custom: row.custom,
			menuGlyph: row.icon ?? OPEN_IN_ICON_FALLBACK,
			launcherGlyph: row.custom && !row.icon ? row.name.slice(0, 1).toUpperCase() : row.icon ?? OPEN_IN_ICON_FALLBACK,
			brandColor: row.brandColor,
			category: row.category,
		}))).toEqual(before);
		expect(BUILTIN_OPEN_IN_TARGETS.map((target) => target.appId)).toEqual(DEFAULT_EXTERNAL_APPS.map((app) => app.id));
	});

	it("keeps bun's detection order and never draws an app bun did not detect", async () => {
		await installOpenInTargetBuiltins();
		contribute({ id: "probe:calc", appId: "calculator", icon: "c" });
		await settle();
		const detected = [DEFAULT_EXTERNAL_APPS[2], custom[0], DEFAULT_EXTERNAL_APPS[0]];
		expect(placeOpenInRows(detected, getOpenInTargetRegistry().list()).map((row) => row.appId)).toEqual(["cursor", "custom-fork", "finder"]);
	});

	it("lets the first target registered for an app draw it: a later one cannot restyle a built-in", async () => {
		await installOpenInTargetBuiltins();
		contribute({ id: "probe:vscode", appId: "vscode", icon: "v", brandColor: "#000000" });
		await settle();
		const [row] = placeOpenInRows([DEFAULT_EXTERNAL_APPS[1]], getOpenInTargetRegistry().list());
		expect(row.icon).toBe(BUILTIN_OPEN_IN_TARGETS[1].icon);
		expect(row.brandColor).toBe(BUILTIN_OPEN_IN_TARGETS[1].brandColor);
	});

	it("[dispose] unloading the plugin that draws an app takes its row out of the open menu", async () => {
		vi.mocked(api.request.getAvailableApps).mockResolvedValue([DEFAULT_EXTERNAL_APPS[1]]);
		const probe = contribute({ id: "probe:vscode", appId: "vscode", icon: "v" });
		await settle();
		renderMenu();
		await settle();
		expect(screen.getByRole("button", { name: /VS Code/ })).toBeInTheDocument();

		await act(() => probe.dispose());

		expect(screen.queryByRole("button", { name: /VS Code/ })).toBeNull();
	});

	it("opens a row by its app id only", async () => {
		vi.mocked(api.request.getAvailableApps).mockResolvedValue([custom[0]]);
		contribute({ id: "probe:fork", appId: "custom-fork", icon: "f" });
		await settle();
		renderMenu();
		await settle();
		await userEvent.click(screen.getByRole("button", { name: /Fork/ }));
		expect(api.request.openInApp).toHaveBeenCalledWith({ appId: "custom-fork", path: "/tmp/wt" });
	});

	it("ignores a malformed target and logs it once, however often the menu re-derives its rows", async () => {
		contribute({ id: "probe:bad", appId: "custom-fork", icon: { glyph: "x" } as never });
		await settle();
		const entries = getOpenInTargetRegistry().list();
		for (let pass = 0; pass < 3; pass++) {
			expect(placeOpenInRows([custom[0]], entries)[0].icon).toBeUndefined();
		}
		expect(errors.mock.calls.filter((call) => String(call[0]).includes("probe:bad"))).toHaveLength(1);
	});
});
