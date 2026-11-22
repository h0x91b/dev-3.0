import { describe, expect, it } from "vitest";
import { normalizeSimplifiedInterface } from "../../shared/simplified-interface";

/**
 * Fixture: `normalizeSimplifiedInterface` as released before task-header items were
 * hidden by registry id (126c185cf). Older installed versions run exactly this on the
 * settings this version writes, so it must keep hiding what the user hid here.
 */
const PREVIOUS_PRESET_IDS = [
	"agent-traffic", "stats-nav", "automations-tab", "keyboard-shortcut-editor",
	"custom-column-creation", "label-creation", "spawn-variant", "spawn-agent",
	"bug-hunters", "hibernate", "scheduled-message", "tmux-pane-controls",
	"scripts-runner", "setup-dev-server", "diff-include-tests",
];
function previousNormalize(settings: { simplifiedMode?: boolean; personalHiddenControls?: string[]; hiddenControls?: string[] }) {
	const personalHiddenControls = [...new Set(settings.personalHiddenControls ?? settings.hiddenControls ?? [])];
	const simplifiedMode = settings.simplifiedMode ?? PREVIOUS_PRESET_IDS.every((id) => (settings.hiddenControls ?? []).includes(id));
	return {
		simplifiedMode,
		personalHiddenControls,
		hiddenControls: [...new Set([...personalHiddenControls, ...(simplifiedMode ? PREVIOUS_PRESET_IDS : [])])],
	};
}

describe("hidden controls written for an older installed version", () => {
	it("keeps a personally hidden task-header item hidden there", () => {
		const written = normalizeSimplifiedInterface({ simplifiedMode: false, personalHiddenControls: ["builtin:session.bug-hunters", "builtin:session.send-later"] });
		const old = previousNormalize(written);
		expect(old.hiddenControls).toContain("bug-hunters");
		expect(old.hiddenControls).toContain("scheduled-message");
	});

	it("keeps the Simplify View preset applied there", () => {
		const old = previousNormalize(normalizeSimplifiedInterface({ simplifiedMode: true, personalHiddenControls: [] }));
		expect(old.hiddenControls).toEqual(expect.arrayContaining(PREVIOUS_PRESET_IDS));
	});

	it("reads back what the older version rewrote without losing or doubling an item", () => {
		const written = normalizeSimplifiedInterface({ simplifiedMode: false, personalHiddenControls: ["builtin:session.hibernate", "agent-traffic"] });
		const back = normalizeSimplifiedInterface(previousNormalize(written));
		expect(back.personalHiddenControls).toEqual(["builtin:session.hibernate", "agent-traffic", "hibernate"]);
		expect(back.hiddenControls.filter((id) => id === "builtin:session.hibernate")).toHaveLength(1);
	});
});
