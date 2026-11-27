import { describe, expect, it } from "vitest";
import { mainPaneEntry } from "../../shared/main-pane-entry";

type Entry = { main?: boolean; id?: string };

describe("mainPaneEntry", () => {
	it("is the entry flagged `main: true`, wherever it stands", () => {
		const main = { main: true, id: "m" };
		expect(mainPaneEntry<Entry>([{ main: false, id: "x" }, main])).toBe(main);
	});

	it("is index 0 only when no entry carries a `main` key (data saved before the flag)", () => {
		const first = { id: "a" };
		expect(mainPaneEntry<Entry>([first, { id: "b" }])).toBe(first);
		expect(mainPaneEntry<Entry>([{ id: "a" }, { main: false, id: "b" }])).toBeUndefined();
		expect(mainPaneEntry<Entry>([])).toBeUndefined();
	});

	it("never promotes an entry marked `main: false`", () => {
		expect(mainPaneEntry<Entry>([{ main: false }])).toBeUndefined();
	});
});
