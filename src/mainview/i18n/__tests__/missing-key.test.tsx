import { render, screen } from "@testing-library/react";
import { I18nProvider, useT, translate } from "../context";
import { markMissingKey } from "../missing-key";
import type { TranslationKey } from "../translations/en";

/** Keys that deliberately exist in no locale, so the fallback is the only path. */
const NOWHERE = "kanban.deliberatelyMissingKey" as TranslationKey;
const NOWHERE_PLURAL = "kanban.deliberatelyMissingPlural";

function Probe({ render: how }: { render: (t: ReturnType<typeof useT>) => string }) {
	const t = useT();
	return <div data-testid="out">{how(t)}</div>;
}

function shown(
	how: (t: ReturnType<typeof useT>) => string,
	locale: "en" | "ru" | "es" = "en",
): string {
	localStorage.setItem("dev3-locale", locale);
	const { unmount } = render(
		<I18nProvider>
			<Probe render={how} />
		</I18nProvider>,
	);
	const text = screen.getByTestId("out").textContent ?? "";
	unmount();
	return text;
}

describe("markMissingKey", () => {
	it("wraps the key in a marker that cannot be mistaken for copy", () => {
		expect(markMissingKey("kanban.foo")).toBe("⟦kanban.foo⟧");
	});

	it("uses a marker that appears in no real translation string", async () => {
		const [en, ru, es] = await Promise.all([
			import("../translations/en"),
			import("../translations/ru"),
			import("../translations/es"),
		]);
		for (const dict of [en.default, ru.default, es.default]) {
			for (const value of Object.values(dict as Record<string, string>)) {
				expect(value).not.toMatch(/[⟦⟧]/);
			}
		}
	});
});

describe("t() with a missing key", () => {
	it("renders the marked key instead of the bare key", () => {
		expect(shown((t) => t(NOWHERE))).toBe("⟦kanban.deliberatelyMissingKey⟧");
	});

	it("renders the marked key in every locale", () => {
		for (const locale of ["en", "ru", "es"] as const) {
			expect(shown((t) => t(NOWHERE), locale)).toBe(
				"⟦kanban.deliberatelyMissingKey⟧",
			);
		}
	});

	it("survives interpolation vars and does not leak a placeholder", () => {
		const out = shown((t) => t(NOWHERE, { count: 1, name: "x" }));
		expect(out).toBe("⟦kanban.deliberatelyMissingKey⟧");
		expect(out).not.toContain("{");
	});

	it("still resolves a key that exists, unmarked", () => {
		expect(shown((t) => t("kanban.noTasks"))).toBe("No tasks");
		expect(shown((t) => t("kanban.noTasks"), "ru")).toBe("Нет задач");
	});
});

describe("t.plural() with a missing base key", () => {
	it("marks the key and keeps the resolved suffix, so the form is visible", () => {
		expect(shown((t) => t.plural(NOWHERE_PLURAL, 1))).toBe(
			"⟦kanban.deliberatelyMissingPlural_one⟧",
		);
		expect(shown((t) => t.plural(NOWHERE_PLURAL, 5))).toBe(
			"⟦kanban.deliberatelyMissingPlural_other⟧",
		);
	});

	it("carries the Russian form, not the English one", () => {
		expect(shown((t) => t.plural(NOWHERE_PLURAL, 3), "ru")).toBe(
			"⟦kanban.deliberatelyMissingPlural_few⟧",
		);
		expect(shown((t) => t.plural(NOWHERE_PLURAL, 11), "ru")).toBe(
			"⟦kanban.deliberatelyMissingPlural_many⟧",
		);
	});

	it("does not crash when vars are passed alongside a missing key", () => {
		expect(shown((t) => t.plural(NOWHERE_PLURAL, 2, { name: "x" }))).toBe(
			"⟦kanban.deliberatelyMissingPlural_other⟧",
		);
	});

	it("still resolves a plural that exists, unmarked", () => {
		expect(shown((t) => t.plural("ports.count", 1))).not.toMatch(/[⟦⟧]/);
		expect(shown((t) => t.plural("ports.count", 3), "ru")).not.toMatch(
			/[⟦⟧]/,
		);
	});
});

describe("translate() for non-React modules", () => {
	it("marks a missing key rather than returning it bare", () => {
		expect(translate(NOWHERE)).toBe("⟦kanban.deliberatelyMissingKey⟧");
	});

	it("survives vars on a missing key", () => {
		expect(translate(NOWHERE, { count: 2 })).toBe(
			"⟦kanban.deliberatelyMissingKey⟧",
		);
	});
});

describe("warnMissingKey", () => {
	/** Fresh module each time: the dedupe set is module-level by design. */
	async function fresh() {
		vi.resetModules();
		return (await import("../missing-key")).warnMissingKey;
	}

	it("warns once per locale+key+reason, not on every render", async () => {
		const warnMissingKey = await fresh();
		const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
		warnMissingKey("kanban.foo", "ru", "missing");
		warnMissingKey("kanban.foo", "ru", "missing");
		warnMissingKey("kanban.foo", "ru", "missing");
		expect(spy).toHaveBeenCalledTimes(1);
		spy.mockRestore();
	});

	it("names the key and distinguishes the three reasons", async () => {
		const warnMissingKey = await fresh();
		const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
		warnMissingKey("kanban.foo", "ru", "missing");
		warnMissingKey("kanban.foo", "ru", "fallback-to-en");
		warnMissingKey("kanban.foo_few", "ru", "wrong-plural-form");
		const lines = spy.mock.calls.map((c) => String(c[0]));
		expect(lines).toHaveLength(3);
		expect(lines[0]).toContain("kanban.foo");
		expect(lines[0]).toContain("not found in any locale");
		expect(lines[1]).toContain("showing the English string");
		expect(lines[2]).toContain("_other form instead");
		spy.mockRestore();
	});
});
