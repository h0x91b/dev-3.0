import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initialInterfaceOnboarding, ONBOARDING_ACTIVE_THRESHOLD_MS } from "../../shared/interface-onboarding";

const mocks = vi.hoisted(() => ({ home: "", settings: {} as Record<string, unknown>, push: vi.fn() }));
vi.mock("../paths", () => ({ get DEV3_HOME() { return mocks.home; } }));
vi.mock("../settings", () => ({
	loadSettings: async () => structuredClone(mocks.settings),
	saveSettings: async (settings: Record<string, unknown>) => { mocks.settings = structuredClone(settings); },
}));
vi.mock("../rpc-handlers/shared", () => ({ getPushMessage: () => mocks.push }));

let now = 0;
beforeEach(() => {
	vi.resetModules();
	mocks.home = mkdtempSync(join(tmpdir(), "interface-onboarding-"));
	mocks.settings = { simplifiedMode: true, simplifiedModeSource: "fresh", personalHiddenControls: ["my-button"] };
	mocks.push.mockClear();
	now = 0;
	vi.spyOn(Date, "now").mockImplementation(() => now);
});
afterEach(() => { vi.restoreAllMocks(); rmSync(mocks.home, { recursive: true, force: true }); });

function seedDue() {
	const state = initialInterfaceOnboarding(true, true, 0);
	state.activeMs = ONBOARDING_ACTIVE_THRESHOLD_MS;
	state.dueAt = 0;
	writeFileSync(join(mocks.home, "interface-onboarding.json"), JSON.stringify(state));
}

describe("interface onboarding host", () => {
	it("serializes simultaneous window claims through one persisted lease", async () => {
		seedDue();
		const { interfaceOnboarding } = await import("../interface-onboarding");
		const replies = await Promise.all(["desktop", "remote"].map((clientId) => interfaceOnboarding({ action: "poll", clientId, active: true, calm: true })));
		expect(replies.filter((reply) => reply.prompt === "invite")).toHaveLength(1);
		const stored = JSON.parse(readFileSync(join(mocks.home, "interface-onboarding.json"), "utf8"));
		expect(["desktop", "remote"]).toContain(stored.lease.clientId);
	});

	it("reloads persisted active time without crediting restart downtime", async () => {
		let { interfaceOnboarding } = await import("../interface-onboarding");
		await interfaceOnboarding({ action: "poll", clientId: "one", active: true });
		now = 15_000;
		expect((await interfaceOnboarding({ action: "poll", clientId: "one", active: true })).activeMs).toBe(15_000);
		vi.resetModules();
		({ interfaceOnboarding } = await import("../interface-onboarding"));
		now = 86_400_000;
		expect((await interfaceOnboarding({ action: "poll", clientId: "two", active: true })).activeMs).toBe(15_000);
	});

	it("persists postponement and rejects another window's decision", async () => {
		seedDue();
		let { interfaceOnboarding } = await import("../interface-onboarding");
		await interfaceOnboarding({ action: "poll", clientId: "one", active: true, calm: true });
		expect((await interfaceOnboarding({ action: "postpone", clientId: "two" })).postponements).toBe(0);
		now = 500;
		await interfaceOnboarding({ action: "postpone", clientId: "one" });
		vi.resetModules();
		({ interfaceOnboarding } = await import("../interface-onboarding"));
		expect(await interfaceOnboarding({ action: "poll", clientId: "new", active: true, calm: true }))
			.toMatchObject({ postponements: 1, dueAt: 86_400_500, prompt: null });
	});

	it("preserves personal hides and informs all windows on mode changes", async () => {
		const { interfaceOnboarding } = await import("../interface-onboarding");
		await interfaceOnboarding({ action: "disable", clientId: "one" });
		expect(mocks.settings).toMatchObject({ simplifiedMode: false, hiddenControls: ["my-button"], personalHiddenControls: ["my-button"] });
		await interfaceOnboarding({ action: "enable", clientId: "one" });
		expect(mocks.settings.simplifiedMode).toBe(true);
		expect(mocks.settings.personalHiddenControls).toEqual(["my-button"]);
		expect(mocks.push).toHaveBeenCalledTimes(2);
	});

	it("records Settings transitions before the first onboarding poll", async () => {
		const { interfaceOnboarding, noteInterfaceModeChange } = await import("../interface-onboarding");
		await noteInterfaceModeChange(true, false, true);
		mocks.settings.simplifiedMode = false;
		expect((await interfaceOnboarding({ action: "poll", clientId: "one", active: true, calm: true })).prompt).toBe("lesson");
		await interfaceOnboarding({ action: "acknowledge", clientId: "one" });
		await noteInterfaceModeChange(false, true, true);
		mocks.settings.simplifiedMode = true;
		expect(await interfaceOnboarding({ action: "poll", clientId: "one", active: true, calm: true }))
			.toMatchObject({ source: "manual", dueAt: 14 * 86_400_000, prompt: null });
	});
});
