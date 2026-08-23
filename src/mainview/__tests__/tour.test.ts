import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { TOURS, tourAdvanceAnchor, tourById } from "../tour";
import en from "../i18n/translations/en";
import ru from "../i18n/translations/ru";
import es from "../i18n/translations/es";

/**
 * A tour fails SILENTLY when an anchor is wrong: the card parks bottom-centre,
 * waits, and then quits as if the user had walked off. Nothing throws and nothing
 * logs. So the anchors are checked against the components the same way help ids
 * are — a renamed button has to break this suite, not the onboarding.
 */

describe("tour registry", () => {
	it("has unique tour ids and unique step ids inside each tour", () => {
		const tourIds = TOURS.map((tour) => tour.id);
		expect(new Set(tourIds).size).toBe(tourIds.length);
		for (const tour of TOURS) {
			const stepIds = tour.steps.map((step) => step.id);
			expect(new Set(stepIds).size, `${tour.id} has duplicate step ids`).toBe(stepIds.length);
		}
	});

	it("resolves every title/body key in all locales", () => {
		for (const tour of TOURS) {
			for (const [name, locale] of [["en", en], ["ru", ru], ["es", es]] as const) {
				expect(locale[tour.titleKey], `${tour.id} titleKey missing in ${name}`).toBeTruthy();
				for (const step of tour.steps) {
					expect(locale[step.titleKey], `${tour.id}/${step.id} titleKey missing in ${name}`).toBeTruthy();
					expect(locale[step.bodyKey], `${tour.id}/${step.id} bodyKey missing in ${name}`).toBeTruthy();
				}
			}
		}
	});

	it("gives every step something to wait for, and only the last step none", () => {
		for (const tour of TOURS) {
			tour.steps.forEach((step, index) => {
				const anchor = tourAdvanceAnchor(tour, index);
				const manual = step.advanceOn === "manual";
				const last = index === tour.steps.length - 1;
				if (manual || last) expect(anchor, `${tour.id}/${step.id}`).toBeNull();
				else expect(anchor, `${tour.id}/${step.id} would never advance`).toBeTruthy();
			});
		}
	});

	it("waits for an anchor that some later step actually points at", () => {
		for (const tour of TOURS) {
			const anchors = new Set(tour.steps.map((step) => step.anchor));
			tour.steps.forEach((_, index) => {
				const target = tourAdvanceAnchor(tour, index);
				if (!target) return;
				expect(anchors.has(target), `${tour.id} step ${index} waits for unknown anchor '${target}'`).toBe(true);
			});
		}
	});

	it("tourById returns undefined for unknown ids", () => {
		expect(tourById("nope")).toBeUndefined();
	});
});

describe("tour anchors exist in the components", () => {
	const SRC_ROOT = path.resolve(__dirname, "..");
	const mounted = new Set<string>();

	(function walk(dir: string) {
		for (const name of readdirSync(dir)) {
			if (name === "__tests__" || name === "assets" || name === "i18n") continue;
			const full = path.join(dir, name);
			if (statSync(full).isDirectory()) {
				walk(full);
				continue;
			}
			// The registry and the engine mention the attribute in prose and in the
			// selector they build; only real markup counts.
			if (!/\.tsx?$/.test(name) || full === path.join(SRC_ROOT, "tour.ts")) continue;
			if (full === path.join(SRC_ROOT, "components", "TourOverlay.tsx")) continue;
			const src = readFileSync(full, "utf8");
			for (const m of src.matchAll(/data-tour-anchor="([a-z0-9.-]+)"/gi)) mounted.add(m[1]);
			// `data-tour-anchor={immersive ? undefined : "task.terminal"}` — a gated
			// anchor is still a real anchor. Only the branches count: a literal in the
			// CONDITION (`task.status === "in-progress" ? …`) is not an anchor, and
			// counting it reported a dead anchor that never existed.
			for (const m of src.matchAll(/data-tour-anchor=\{([^}]*)\}/g)) {
				const branches = m[1].includes("?") ? m[1].slice(m[1].indexOf("?") + 1) : m[1];
				for (const lit of branches.matchAll(/"([a-z0-9.-]+)"/gi)) mounted.add(lit[1]);
			}
		}
	})(SRC_ROOT);

	it("every step points at an anchor some component carries", () => {
		const dangling = TOURS.flatMap((tour) =>
			tour.steps.filter((step) => !mounted.has(step.anchor)).map((step) => `${tour.id}/${step.id} → ${step.anchor}`),
		);
		expect(dangling, `steps pointing at nothing: ${dangling.join(", ")}`).toEqual([]);
	});

	it("has no anchor left in the markup that no tour uses", () => {
		const used = new Set(TOURS.flatMap((tour) => tour.steps.map((step) => step.anchor)));
		const orphans = [...mounted].filter((anchor) => !used.has(anchor));
		expect(orphans, `dead tour anchors: ${orphans.join(", ")}`).toEqual([]);
	});
});
