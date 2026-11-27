import { describe, expect, it } from "vitest";
import { mainPaneEntry } from "../../shared/main-pane-entry";

type Entry = { main?: boolean; id?: string };

describe("mainPaneEntry", () => {
	it("is the entry flagged `main: true`, wherever it stands", () => {
		const main = { main: true, id: "m" };
		expect(mainPaneEntry<Entry>([{ main: false, id: "x" }, main])).toBe(main);
	});

	it("is index 0 when that entry carries no `main` key (data saved before the flag), whatever the later entries say", () => {
		const first = { id: "a" };
		expect(mainPaneEntry<Entry>([first, { id: "b" }])).toBe(first);
		expect(mainPaneEntry<Entry>([first, { main: false, id: "b" }])).toBe(first);
		expect(mainPaneEntry<Entry>([])).toBeUndefined();
	});

	it("is nobody when index 0 is an extra marked `main: false` and no entry is flagged", () => {
		expect(mainPaneEntry<Entry>([{ main: false, id: "x" }, { id: "legacy" }])).toBeUndefined();
	});

	it("never promotes an entry marked `main: false`", () => {
		expect(mainPaneEntry<Entry>([{ main: false }])).toBeUndefined();
	});
});
