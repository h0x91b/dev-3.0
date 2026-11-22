import { resolveMenuRow, runMenuItem, resetMenuRowFailuresForTests, type MenuSlotItem } from "../menu-rows";

const boom = (): never => {
	throw new Error("boom");
};

let errors: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
	resetMenuRowFailuresForTests();
	errors = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => errors.mockRestore());

describe("menu-rows", () => {
	it("reports a broken item once per slot, id and phase, however often an open menu re-resolves it", async () => {
		const item: MenuSlotItem<null, "g"> = { id: "acme:x", region: "g", label: boom };
		for (let render = 0; render < 25; render++) expect(resolveMenuRow("fileMenu", item, null)).toBeNull();
		// The same id on another slot is its own report; a run failure is a phase of its own.
		resolveMenuRow("taskMenu", item, null);
		for (let click = 0; click < 3; click++) runMenuItem("fileMenu", "acme:x", boom, null);
		runMenuItem("fileMenu", "acme:async", () => Promise.reject(new Error("later")), null);
		await Promise.resolve();
		await Promise.resolve();
		expect(errors.mock.calls.map((call: unknown[]) => String(call[0]))).toEqual([
			'[fileMenu] "acme:x" failed to resolve',
			'[taskMenu] "acme:x" failed to resolve',
			'[fileMenu] "acme:x" failed',
			'[fileMenu] "acme:async" failed',
		]);
	});

	it("reports again after the test reset", () => {
		const item: MenuSlotItem<null, "g"> = { id: "acme:x", region: "g", label: () => "x", when: boom };
		resolveMenuRow("fileMenu", item, null);
		resetMenuRowFailuresForTests();
		resolveMenuRow("fileMenu", item, null);
		expect(errors).toHaveBeenCalledTimes(2);
	});
});
