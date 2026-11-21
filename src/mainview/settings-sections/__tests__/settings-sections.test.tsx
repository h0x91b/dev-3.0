import { render, screen } from "@testing-library/react";
import type { Context } from "cordis";
import { I18nProvider } from "../../i18n";
import en from "../../i18n/translations/en";
import { applyBuiltinPlugins } from "../../plugins/runtime";
import type { SlotEntry } from "../../plugins/slot-registry";
import { filterSettingsEntries, SETTINGS_CATEGORIES, SETTINGS_ENTRIES, type SettingsEntry } from "../../settings-registry";
import { BUILTIN_SETTINGS_SECTIONS_PLUGIN } from "../builtins";
import { getSettingsSectionsRegistry, type SettingsSectionItem } from "../registry";
import { SettingsCategoryPage } from "../SettingsCategoryPage";

vi.mock("../../rpc", () => ({ isElectrobun: false, api: { request: {} } }));

const t = (key: string) => (en as Record<string, string>)[key] ?? key;

// The page order the hard-coded category switch rendered before the slot existed.
const PAGE_ORDER_BEFORE_THE_SLOT: Record<string, string[]> = {
	appearance: ["appearance"],
	tasks: ["behavior", "epics"],
	notifications: ["notifications"],
	keyboard: ["keyboard"],
	terminal: ["terminal"],
	agents: ["agents", "agent-rate-limit", "agent-env-defaults", "claude-mods"],
	accounts: ["accounts"],
	models: ["models"],
	extensions: ["extensions"],
	workspace: ["workspace"],
	system: ["system", "telemetry", "pxpipe-proxy", "advanced-experience", "developer-tools"],
};

function registeredEntries(): SettingsEntry[] {
	return getSettingsSectionsRegistry().list().flatMap((section) => [...section.def.entries]);
}

describe("settingsSections built-ins", () => {
	beforeAll(() => applyBuiltinPlugins([], [BUILTIN_SETTINGS_SECTIONS_PLUGIN]));

	it.each(SETTINGS_CATEGORIES.map((category) => category.id))("renders the %s page's sections in their old order", (category) => {
		const ids = getSettingsSectionsRegistry().listRegion(category).map((section) => section.def.id);
		expect(ids).toEqual(PAGE_ORDER_BEFORE_THE_SLOT[category].map((id) => `builtin:${id}`));
	});

	it("attaches every built-in settings row to exactly one section", () => {
		const ids = registeredEntries().map((entry) => entry.id);
		expect(ids).toHaveLength(SETTINGS_ENTRIES.length);
		expect(new Set(ids)).toEqual(new Set(SETTINGS_ENTRIES.map((entry) => entry.id)));
	});

	it("puts every row on the page of its own category", () => {
		for (const section of getSettingsSectionsRegistry().list()) {
			for (const entry of section.def.entries) expect(entry.category).toBe(section.def.region);
		}
	});

	it("finds, for every built-in title, the same rows the static list found", () => {
		const entries = registeredEntries();
		const ids = (list: readonly SettingsEntry[]) => list.map((entry) => entry.id).sort();
		for (const entry of SETTINGS_ENTRIES) {
			const title = t(entry.titleKey);
			expect(ids(filterSettingsEntries(title, t, entries)), title).toEqual(ids(filterSettingsEntries(title, t, SETTINGS_ENTRIES)));
			expect(ids(filterSettingsEntries(title, t, entries)), title).toContain(entry.id);
		}
	});
});

describe("SettingsCategoryPage", () => {
	const ctx = {} as Context;
	function section(id: string, region: SettingsSectionItem["region"], component: SettingsSectionItem["component"]): SlotEntry<SettingsSectionItem> {
		return { ctx, def: { id, region, order: 0, entries: [], component } };
	}

	it("renders only the category's sections, in the given order", () => {
		render(
			<I18nProvider>
				<SettingsCategoryPage
					region="system"
					sections={[
						section("builtin:a", "system", () => <p>first</p>),
						section("builtin:b", "models", () => <p>elsewhere</p>),
						section("builtin:c", "system", () => <p>second</p>),
					]}
				/>
			</I18nProvider>,
		);
		expect(screen.getAllByText(/first|second/).map((el) => el.textContent)).toEqual(["first", "second"]);
		expect(screen.queryByText("elsewhere")).toBeNull();
	});

	it("isolates a section that throws: a notice in its place, its neighbours intact", () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		function Broken(): never {
			throw new Error("boom");
		}
		render(
			<I18nProvider>
				<SettingsCategoryPage
					region="system"
					sections={[
						section("builtin:a", "system", () => <p>before</p>),
						section("builtin:broken", "system", Broken),
						section("builtin:c", "system", () => <p>after</p>),
					]}
				/>
			</I18nProvider>,
		);
		expect(screen.getByRole("alert")).toHaveTextContent(en["settings.sectionCrashed"]);
		expect(screen.getByText("before")).toBeInTheDocument();
		expect(screen.getByText("after")).toBeInTheDocument();
	});

	it("drops an extension's section that throws, with no inline notice (bible §5.12)", () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		function Broken(): never {
			throw new Error("boom");
		}
		render(
			<I18nProvider>
				<SettingsCategoryPage
					region="system"
					sections={[section("builtin:a", "system", () => <p>before</p>), section("some-ext:broken", "system", Broken)]}
				/>
			</I18nProvider>,
		);
		expect(screen.queryByRole("alert")).toBeNull();
		expect(screen.getByText("before")).toBeInTheDocument();
	});
});
