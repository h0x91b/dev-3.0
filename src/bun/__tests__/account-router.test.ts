import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentAccount, AgentAccountsState } from "../../shared/agent-accounts";
import type { AgentRateLimitSnapshot, AgentRateLimitsReport } from "../../shared/rate-limits";
import type { Project } from "../../shared/types";

const state = vi.hoisted(() => ({ accounts: null as unknown, report: null as unknown, settings: {} as Record<string, unknown>, env: {} as Record<string, string> }));

vi.mock("../agent-accounts", () => ({ listAgentAccounts: vi.fn(async () => state.accounts) }));
vi.mock("../rate-limit-monitor", () => ({
	getCachedRateLimitsReport: vi.fn(() => state.report),
	getAgentRateLimitsReport: vi.fn(async () => state.report),
}));
vi.mock("../settings", () => ({ loadSettings: vi.fn(async () => state.settings) }));
vi.mock("../repo-config", () => ({ resolveProjectEnv: vi.fn(async () => state.env) }));

import {
	NoEligibleAccountError,
	autoLaunchDeferral,
	autoRoutingContext,
	pickAutoAccount,
	previewAutoAccount,
	releaseAccountReservation,
	resetAccountRouterForTests,
} from "../account-router";

const H = 3_600_000;

function account(id: string, extra: Partial<AgentAccount> = {}): AgentAccount {
	return {
		id,
		kind: "claude",
		label: id,
		identity: { email: `${id}@x`, organization: "org", plan: "default_claude_max_5x", planLabel: "Max 5x", accountId: `uuid-${id}` },
		auth: "oauth",
		api: null,
		createdAt: 0,
		...extra,
	};
}

function snapshot(accountId: string, s: number, w = 40): AgentRateLimitSnapshot {
	const now = Date.now();
	return {
		source: "claude",
		accountId,
		capturedAt: now,
		windows: [
			{ id: "five_hour", usedPercent: s, resetsAt: now + 2 * H, windowMinutes: 300 },
			{ id: "seven_day", usedPercent: w, resetsAt: now + 80 * H, windowMinutes: 10080 },
		],
		creditsBalance: null,
		monthlyCredits: null,
		planType: null,
	};
}

function setup(accounts: AgentAccount[], snapshots: AgentRateLimitSnapshot[]): void {
	const accountsState: AgentAccountsState = {
		claude: { accounts, activeId: accounts[0]?.id ?? null, systemConfigDir: "/h/.claude", systemIdentity: null },
		codex: { accounts: [], activeId: null, currentIdentity: null },
		omp: { accounts: [], activeId: null },
	};
	state.accounts = accountsState;
	state.report = { snapshots, generatedAt: Date.now() } satisfies AgentRateLimitsReport;
}

const project = { id: "p1", path: "/repo", autoAccountExclusions: [] } as unknown as Project;

beforeEach(() => {
	resetAccountRouterForTests();
	state.settings = {};
	state.env = {};
});

describe("pickAutoAccount", () => {
	it("reserves each pick so a burst spreads across accounts", async () => {
		setup([account("a"), account("b")], [snapshot("a", 20), snapshot("b", 22)]);
		const picks = [];
		for (let i = 0; i < 4; i++) picks.push((await pickAutoAccount({ kind: "claude", reservationKey: `k${i}` })).accountId);
		expect(new Set(picks)).toEqual(new Set(["a", "b"]));
	});

	it("routes concurrent picks against each other's reservations", async () => {
		setup([account("a"), account("b")], [snapshot("a", 20), snapshot("b", 21)]);
		const picks = await Promise.all([0, 1].map((i) => pickAutoAccount({ kind: "claude", reservationKey: `c${i}` })));
		expect(picks.map((p) => p.accountId).sort()).toEqual(["a", "b"]);
	});

	it("drops a released reservation", async () => {
		setup([account("a"), account("b")], [snapshot("a", 20), snapshot("b", 24)]);
		expect((await pickAutoAccount({ kind: "claude", reservationKey: "x" })).accountId).toBe("a");
		releaseAccountReservation("x");
		expect((await previewAutoAccount({ kind: "claude" })).accountId).toBe("a");
	});

	it("previews without reserving", async () => {
		setup([account("a"), account("b")], [snapshot("a", 20), snapshot("b", 24)]);
		await previewAutoAccount({ kind: "claude" });
		await previewAutoAccount({ kind: "claude" });
		expect((await pickAutoAccount({ kind: "claude", reservationKey: "y" })).accountId).toBe("a");
	});

	it("never falls back to an API profile", async () => {
		setup([account("a"), account("api", { auth: "api", identity: null })], [snapshot("a", 95)]);
		await expect(pickAutoAccount({ kind: "claude", reservationKey: "z" })).rejects.toBeInstanceOf(NoEligibleAccountError);
	});

	it("honours the project's exclusions", async () => {
		setup([account("a"), account("b")], [snapshot("a", 10), snapshot("b", 40)]);
		expect((await pickAutoAccount({ kind: "claude", exclusions: ["a"], reservationKey: "e" })).accountId).toBe("b");
	});
});

describe("autoRoutingContext", () => {
	it("flags a project that pins its own Claude config dir", async () => {
		state.env = { CLAUDE_CONFIG_DIR: "/work/.claude-work" };
		expect((await autoRoutingContext(project, "k")).claudeConfigPinned).toBe(true);
		state.env = {};
		expect((await autoRoutingContext({ ...project, autoAccountExclusions: ["b"] } as Project, "k")).exclusions).toEqual(["b"]);
	});
});

describe("autoLaunchDeferral", () => {
	it("returns the earliest reset when every Auto variant is blocked", async () => {
		setup([account("a")], [snapshot("a", 95)]);
		const at = await autoLaunchDeferral(project, [{ accountId: "auto" }], ["claude"]);
		expect(at).toBeGreaterThan(Date.now());
	});

	it("leaves launches that can go now, explicit picks and non-routable harnesses alone", async () => {
		setup([account("a")], [snapshot("a", 95)]);
		expect(await autoLaunchDeferral(project, [{ accountId: "a" }], ["claude"])).toBeNull();
		expect(await autoLaunchDeferral(project, [{ accountId: "auto" }], [null])).toBeNull();
		expect(await autoLaunchDeferral(project, [{ accountId: undefined }], ["claude"])).toBeNull();
		setup([account("a")], [snapshot("a", 30)]);
		expect(await autoLaunchDeferral(project, [{ accountId: "auto" }], ["claude"])).toBeNull();
	});

	it("follows a default set to Auto", async () => {
		state.settings = { autoAccountDefault: { claude: true } };
		setup([account("a")], [snapshot("a", 95)]);
		expect(await autoLaunchDeferral(project, [{ accountId: undefined }], ["claude"])).not.toBeNull();
	});
});
