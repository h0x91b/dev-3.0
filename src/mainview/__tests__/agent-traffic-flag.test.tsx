import { render, screen } from "@testing-library/react";
import type { AgentMessageLogPage } from "../../shared/agent-message-log";
import { buildApplicationMenu, isComingSoonAction } from "../../shared/application-menu";
import { buildBrowserMenu } from "../components/AppMenuBar";
import { BROWSER_HANDLED_ACTIONS } from "../menuRouter";
import { I18nProvider } from "../i18n";
import { resetTrafficSeen, resetTrafficStore } from "../agent-traffic";
import {
	getAgentTrafficEnabled,
	setAgentTrafficEnabledForTests,
	syncAgentTrafficFromGlobalSettings,
} from "../agent-traffic-flag";
import { availableCommands } from "../commands";
import { appShortcutsForMode } from "../keymap";
import { getAvailableTipsCount } from "../tips";
import AgentTrafficIndicator from "../components/agent-traffic/AgentTrafficIndicator";

/**
 * The agent-traffic beta ships off, and while off it must leave NO trace: no
 * header control, no listed shortcut, no menu row, no palette command, no tip.
 * Each surface is asserted in both states, because "hidden" is only meaningful
 * next to a proof that it appears when the user opts in.
 */

const page: AgentMessageLogPage = { rows: [], oldestDay: null, retentionDays: 30, hasMore: false };

vi.mock("../rpc", () => ({
	api: {
		request: {
			readAgentMessageLog: vi.fn(() => Promise.resolve(page)),
			getTasks: vi.fn(() => Promise.resolve([])),
		},
	},
}));

beforeEach(() => {
	resetTrafficStore();
	resetTrafficSeen();
	setAgentTrafficEnabledForTests(false);
});

function renderIndicator(variant: "bar" | "menu" | "sheet") {
	return render(
		<I18nProvider>
			<AgentTrafficIndicator projectId="proj-1" navigate={() => {}} onOpenLog={() => {}} variant={variant} />
		</I18nProvider>,
	);
}

/** Every leaf label in a built native menu, submenus flattened. */
function menuLabels(items: unknown[]): string[] {
	const out: string[] = [];
	for (const entry of items) {
		const item = entry as { label?: string; submenu?: unknown[] };
		if (item.label) out.push(item.label);
		if (item.submenu) out.push(...menuLabels(item.submenu));
	}
	return out;
}

const MENU_CTX = { hasTask: true, hasProject: true, hasTerminal: true };

/** Leaf labels of the browser-mode menu tree, submenus flattened. */
function browserLabels(nodes: ReturnType<typeof buildBrowserMenu>): string[] {
	const out: string[] = [];
	for (const node of nodes) {
		if (node.kind === "item") out.push(node.label);
		if (node.kind === "submenu") out.push(...browserLabels(node.children));
	}
	return out;
}

describe("agent-traffic feature flag", () => {
	it("defaults to off", () => {
		expect(getAgentTrafficEnabled()).toBe(false);
	});

	it("only an explicit true switches it on, and the change is announced", () => {
		const seen: boolean[] = [];
		const listener = (e: Event) => seen.push((e as CustomEvent<boolean>).detail);
		window.addEventListener("agent-traffic-flag-changed", listener);

		syncAgentTrafficFromGlobalSettings({});
		expect(getAgentTrafficEnabled()).toBe(false);

		syncAgentTrafficFromGlobalSettings({ experimentalAgentTraffic: true });
		expect(getAgentTrafficEnabled()).toBe(true);

		// Same value again is not a change — no second event.
		syncAgentTrafficFromGlobalSettings({ experimentalAgentTraffic: true });
		syncAgentTrafficFromGlobalSettings({ experimentalAgentTraffic: false });

		window.removeEventListener("agent-traffic-flag-changed", listener);
		expect(seen).toEqual([true, false]);
	});

	it.each(["bar", "menu", "sheet"] as const)("renders no %s control while off", (variant) => {
		renderIndicator(variant);
		expect(screen.queryByRole("button")).toBeNull();
	});

	it("renders the kebab row once switched on", () => {
		setAgentTrafficEnabledForTests(true);
		renderIndicator("menu");
		expect(screen.getByTestId("agent-traffic-menu-row")).toBeTruthy();
	});

	it("hides the shortcut from the keymap listing while off", () => {
		const off = appShortcutsForMode(false).map((s) => s.id);
		expect(off).not.toContain("agent-traffic-log");

		setAgentTrafficEnabledForTests(true);
		expect(appShortcutsForMode(false).map((s) => s.id)).toContain("agent-traffic-log");
	});

	it("hides the palette command while off", () => {
		const ctx = { hasTask: true, hasProject: true };
		expect(availableCommands(ctx).map((c) => c.id)).not.toContain("view-agent-traffic-log");

		setAgentTrafficEnabledForTests(true);
		expect(availableCommands(ctx).map((c) => c.id)).toContain("view-agent-traffic-log");
	});

	it("hides the native-menu rows while off, in both View and Help", () => {
		const off = menuLabels(buildApplicationMenu({ ...MENU_CTX, agentTrafficEnabled: false }));
		expect(off.filter((l) => l.startsWith("Agent Traffic Log"))).toHaveLength(0);

		const on = menuLabels(buildApplicationMenu({ ...MENU_CTX, agentTrafficEnabled: true }));
		expect(on.filter((l) => l.startsWith("Agent Traffic Log"))).toHaveLength(2);
	});

	it("reaches the browser menu bar too, and is not a roadmap placeholder", () => {
		// Both were true when the feature shipped: the action sat in
		// NOT_YET_IMPLEMENTED (so the native rows rendered disabled) and was absent
		// from BROWSER_HANDLED_ACTIONS (so the browser menu dropped it).
		expect(isComingSoonAction("view-agent-traffic-log")).toBe(false);
		expect(BROWSER_HANDLED_ACTIONS.has("view-agent-traffic-log")).toBe(true);

		const off = buildBrowserMenu({ ...MENU_CTX, agentTrafficEnabled: false });
		expect(browserLabels(off).filter((l) => l.startsWith("Agent Traffic Log"))).toHaveLength(0);

		const on = buildBrowserMenu({ ...MENU_CTX, agentTrafficEnabled: true });
		expect(browserLabels(on).filter((l) => l.startsWith("Agent Traffic Log"))).toHaveLength(2);
	});

	it("keeps the tip out of the pool while off", () => {
		const state = { seen: {}, snoozedUntil: 0, rotationIndex: 0 };
		const off = getAvailableTipsCount(state);

		setAgentTrafficEnabledForTests(true);
		expect(getAvailableTipsCount(state)).toBe(off + 1);
	});
});
