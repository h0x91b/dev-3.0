import { interpolate, getPluralForm } from "../interpolate";

describe("interpolate", () => {
	it("replaces single variable", () => {
		expect(interpolate("Hello {name}", { name: "World" })).toBe(
			"Hello World",
		);
	});

	it("replaces multiple variables", () => {
		expect(
			interpolate("{a} and {b}", { a: "one", b: "two" }),
		).toBe("one and two");
	});

	it("leaves unknown placeholders intact", () => {
		expect(interpolate("{known} {unknown}", { known: "yes" })).toBe(
			"yes {unknown}",
		);
	});

	it("converts numbers to strings", () => {
		expect(interpolate("{count} items", { count: 42 })).toBe("42 items");
	});

	it("returns template as-is when no vars match", () => {
		expect(interpolate("no vars here", {})).toBe("no vars here");
	});
});

describe("getPluralForm", () => {
	describe("English", () => {
		it("returns 'one' for 1", () => {
			expect(getPluralForm(1, "en")).toBe("one");
		});

		it("returns 'other' for 0", () => {
			expect(getPluralForm(0, "en")).toBe("other");
		});

		it("returns 'other' for 5", () => {
			expect(getPluralForm(5, "en")).toBe("other");
		});
	});

	describe("Russian", () => {
		it("returns 'one' for 1", () => {
			expect(getPluralForm(1, "ru")).toBe("one");
		});

		it("returns 'one' for 21", () => {
			expect(getPluralForm(21, "ru")).toBe("one");
		});

		it("returns 'few' for 2", () => {
			expect(getPluralForm(2, "ru")).toBe("few");
		});

		it("returns 'few' for 3", () => {
			expect(getPluralForm(3, "ru")).toBe("few");
		});

		it("returns 'few' for 22", () => {
			expect(getPluralForm(22, "ru")).toBe("few");
		});

		it("returns 'many' for 5", () => {
			expect(getPluralForm(5, "ru")).toBe("many");
		});

		it("returns 'many' for 11", () => {
			expect(getPluralForm(11, "ru")).toBe("many");
		});

		it("returns 'many' for 12", () => {
			expect(getPluralForm(12, "ru")).toBe("many");
		});

		it("returns 'many' for 14", () => {
			expect(getPluralForm(14, "ru")).toBe("many");
		});

		it("returns 'many' for 0", () => {
			expect(getPluralForm(0, "ru")).toBe("many");
		});

		// The few/many boundary is where the hand-rolled mod-10/mod-100 branch
		// this function replaced used to live. Same answers, from CLDR now.
		it.each([
			[101, "one"],
			[102, "few"],
			[111, "many"],
			[1001, "one"],
		])("returns '%s' → %s", (count, form) => {
			expect(getPluralForm(count as number, "ru")).toBe(form);
		});
	});

	describe("Spanish", () => {
		it("returns 'one' for 1", () => {
			expect(getPluralForm(1, "es")).toBe("one");
		});

		it("returns 'other' for 0", () => {
			expect(getPluralForm(0, "es")).toBe("other");
		});

		it("returns 'other' for 7", () => {
			expect(getPluralForm(7, "es")).toBe("other");
		});
	});
});
