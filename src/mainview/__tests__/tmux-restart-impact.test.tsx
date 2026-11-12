import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { I18nProvider, useT } from "../i18n";
import { describeTmuxRestartImpact } from "../tmux-restart-impact";

function tFor(locale: "en" | "ru") {
	localStorage.setItem("dev3-locale", locale);
	return renderHook(() => useT(), { wrapper: I18nProvider }).result.current;
}

describe("describeTmuxRestartImpact", () => {
	afterEach(() => localStorage.clear());

	it("names every agent that is mid-turn, under the terminal counts", () => {
		const text = describeTmuxRestartImpact(
			{
				taskTerminals: 5,
				otherSessions: 1,
				working: [
					{ taskId: "a", seqLabel: "1801", title: "Coordinate the board", projectName: "dev-3.0" },
					{ taskId: "b", seqLabel: "12-2", title: "Fix the login race", projectName: "web" },
				],
			},
			tFor("en"),
		);
		expect(text).toBe(
			"5 task terminals close. 1 other terminal or dev server stops too.\n" +
				"2 agents are mid-turn and get cut off:\n" +
				"• #1801 Coordinate the board · dev-3.0\n" +
				"• #12-2 Fix the login race · web",
		);
	});

	it("says so when no agent is working", () => {
		expect(describeTmuxRestartImpact({ taskTerminals: 1, otherSessions: 0, working: [] }, tFor("en"))).toBe(
			"1 task terminal closes. No agent is working right now.",
		);
	});

	it("falls back to a warning that everything closes when the server could not be read", () => {
		expect(describeTmuxRestartImpact(null, tFor("en"))).toMatch(/Every terminal on this tmux server will close/);
	});

	it("agrees the count in Russian", () => {
		expect(describeTmuxRestartImpact({ taskTerminals: 5, otherSessions: 0, working: [] }, tFor("ru"))).toBe(
			"Закроются 5 терминалов задач. Сейчас ни один агент не работает.",
		);
	});
});
