import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { HELP_TOPICS, REQUIRED_HELP_SURFACES, helpTopic, statusHelpTopicId } from "../help";
import { APP_SHORTCUTS } from "../keymap";
import en from "../i18n/translations/en";
import ru from "../i18n/translations/ru";
import es from "../i18n/translations/es";
import { ALL_STATUSES } from "../../shared/types";

describe("HELP_TOPICS registry", () => {
	it("has unique topic ids", () => {
		const ids = HELP_TOPICS.map((topic) => topic.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("resolves every title/body key in all locales", () => {
		for (const topic of HELP_TOPICS) {
			for (const [name, locale] of [["en", en], ["ru", ru], ["es", es]] as const) {
				expect(locale[topic.titleKey], `${topic.id} titleKey missing in ${name}`).toBeTruthy();
				expect(locale[topic.bodyKey], `${topic.id} bodyKey missing in ${name}`).toBeTruthy();
			}
		}
	});

	it("references only existing keymap shortcut ids", () => {
		const known = new Set(APP_SHORTCUTS.map((s) => s.id));
		for (const topic of HELP_TOPICS) {
			for (const id of topic.shortcutIds ?? []) {
				expect(known.has(id), `${topic.id} references unknown shortcut '${id}'`).toBe(true);
			}
		}
	});

	it("resolves link labels in all locales", () => {
		for (const topic of HELP_TOPICS) {
			if (!topic.link) continue;
			for (const locale of [en, ru, es]) {
				expect(locale[topic.link.labelKey]).toBeTruthy();
			}
		}
	});

	it("has a column topic for every task status", () => {
		for (const status of ALL_STATUSES) {
			const topic = helpTopic(statusHelpTopicId(status));
			expect(topic, `no help topic for status '${status}'`).toBeDefined();
		}
	});

	it("helpTopic returns undefined for unknown ids", () => {
		expect(helpTopic("nope.nothing")).toBeUndefined();
	});
});

// Bible §5.4 correlation invariant: help mode is the master surface. A
// dangling id is a SILENT no-op (HelpSpot renders nothing, help mode skips
// the zone) and an orphan topic is dead copy — both directions must fail loud.
describe("help coverage correlation (bible §5.4)", () => {
	const SRC_ROOT = path.resolve(__dirname, "..");
	const referenced = new Set<string>();

	(function walk(dir: string) {
		for (const name of readdirSync(dir)) {
			if (name === "__tests__" || name === "assets" || name === "i18n") continue;
			const full = path.join(dir, name);
			if (statSync(full).isDirectory()) {
				walk(full);
				continue;
			}
			if (!/\.tsx?$/.test(name) || full === path.join(SRC_ROOT, "help.ts")) continue;
			const src = readFileSync(full, "utf8");
			// Literal zone tags and HelpSpot/section topic props. Dynamic ids
			// (statusHelpTopicId) are deliberately not captured here, and the
			// id-shape filter drops docstring placeholders like "<topic id>".
			for (const m of src.matchAll(/(?:data-help-id|topicId|helpTopicId)="([^"]+)"/g)) {
				if (/^[a-z0-9.-]+$/i.test(m[1])) referenced.add(m[1]);
			}
		}
	})(SRC_ROOT);

	it("every referenced help id resolves to a registry topic (no silent no-ops)", () => {
		const dangling = [...referenced].filter((id) => !helpTopic(id));
		expect(dangling, `dangling help ids (help mode skips them silently): ${dangling.join(", ")}`).toEqual([]);
	});

	it("every registry topic is mounted in a component (no dead copy)", () => {
		const orphans = HELP_TOPICS.map((topic) => topic.id)
			// board.column.* render dynamically via statusHelpTopicId — covered
			// by the per-status test above.
			.filter((id) => !id.startsWith("board.column."))
			.filter((id) => !referenced.has(id));
		expect(orphans, `orphan topics (no HelpSpot/zone references them): ${orphans.join(", ")}`).toEqual([]);
	});

	// Coverage FLOOR (bible §5.4 "help coverage is owed, not earned"). The two
	// checks above only police ids that are ALREADY referenced — a §5 surface
	// with NO help id reads as "fine". This asserts the positive contract: every
	// canonical surface in REQUIRED_HELP_SURFACES resolves to a topic AND mounts a
	// reachable zone. New surfaces can't ship uncovered (keymap.ts-style lockstep).
	it("every required §5 surface resolves to a topic and is reachable in help mode", () => {
		const missing = REQUIRED_HELP_SURFACES.filter((id) => !helpTopic(id));
		const unreachable = REQUIRED_HELP_SURFACES.filter((id) => helpTopic(id) && !referenced.has(id));
		expect(missing, `required surfaces with no registry topic: ${missing.join(", ")}`).toEqual([]);
		expect(
			unreachable,
			`required surfaces not reachable in help mode (no data-help-id / HelpSpot zone in any component): ${unreachable.join(", ")}`,
		).toEqual([]);
	});

	it("REQUIRED_HELP_SURFACES has no duplicate ids", () => {
		expect(new Set(REQUIRED_HELP_SURFACES).size).toBe(REQUIRED_HELP_SURFACES.length);
	});
});
