import { describe, expect, it } from "vitest";
import { HELP_TOPICS, helpTopic, statusHelpTopicId } from "../help";
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
