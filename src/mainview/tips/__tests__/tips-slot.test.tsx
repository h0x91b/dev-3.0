import type { MockInstance } from "vitest";
import { act, render, screen } from "@testing-library/react";
import type { Context } from "cordis";
import type { TipState } from "../../../shared/types";
import { I18nProvider } from "../../i18n";
import { api } from "../../rpc";
import { getAppRoot } from "../../plugins/root";
import { applyBuiltinPlugins, resetPluginsForTests } from "../../plugins/runtime";
import { BUILTIN_TIPS, BUILTIN_TIPS_PLUGIN } from "../builtins";
import { getTipRegistry, tipStateKey, type Tip } from "../registry";
import { resetTipFailuresForTests } from "../rotation";
import { TipCarrier } from "./TipCarrier";

vi.mock("../../rpc", () => ({
	api: { request: { getTipState: vi.fn(), updateTipState: vi.fn() } },
}));

const extra: Tip = {
	id: "probe:tip",
	titleKey: "tip.agentTrafficLog.title",
	bodyKey: "tip.agentTrafficLog.body",
	icon: "x",
	score: 5,
	contexts: ["board"],
};

/** Every built-in on cool-down, so whatever the carrier shows came from the probe. */
const allBuiltinsSeen: TipState = {
	snoozedUntil: 0,
	rotationIndex: 0,
	seen: Object.fromEntries(BUILTIN_TIPS.map((tip) => [tipStateKey(tip), Date.now()])),
};

async function settle(): Promise<void> {
	for (let tick = 0; tick < 50; tick++) await act(async () => {});
}

function contribute(tip: Tip) {
	return getAppRoot().plugin({ name: "tip-probe", inject: ["tips"], apply: (ctx: Context) => void ctx.tips.register(tip) });
}

let errors: MockInstance<typeof console.error>;

beforeEach(async () => {
	resetPluginsForTests();
	resetTipFailuresForTests();
	errors = vi.spyOn(console, "error").mockImplementation(() => {});
	vi.mocked(api.request.getTipState).mockResolvedValue(allBuiltinsSeen);
	applyBuiltinPlugins([], [BUILTIN_TIPS_PLUGIN]);
	await settle();
});

afterEach(() => vi.restoreAllMocks());

describe("tips slot", () => {
	it("registers every built-in tip under its old key, in the order the host rotates them", () => {
		expect(getTipRegistry().list().map((entry) => entry.def)).toEqual(BUILTIN_TIPS);
		expect(BUILTIN_TIPS.every((tip) => tip.id.startsWith("builtin:tip."))).toBe(true);
	});

	it("[dispose] unloading the plugin that contributed the tip on screen takes it off the card", async () => {
		const probe = contribute(extra);
		await settle();
		render(<I18nProvider><TipCarrier /></I18nProvider>);
		await settle();
		expect(screen.getByText("Read what your agents said")).toBeInTheDocument();

		await act(() => probe.dispose());

		expect(screen.queryByText("Read what your agents said")).toBeNull();
		expect(screen.getByTestId("no-tip")).toBeInTheDocument();
	});

	it("logs a throwing when() once per tip, however often the carrier re-selects", async () => {
		contribute({ ...extra, when: () => { throw new Error("tip boom"); } });
		await settle();
		const { rerender } = render(<I18nProvider><TipCarrier /></I18nProvider>);
		await settle();
		rerender(<I18nProvider><TipCarrier key="again" /></I18nProvider>);
		await settle();
		expect(screen.getByTestId("no-tip")).toBeInTheDocument();
		expect(errors.mock.calls.filter((call) => String(call[0]).includes("probe:tip"))).toHaveLength(1);
	});
});
