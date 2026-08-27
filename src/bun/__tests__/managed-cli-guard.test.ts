import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
	DEV_BUILD_CHANNEL,
	MANAGED_CLI_OPT_IN_ENV,
	mayWriteManagedCli,
	resolveBuildChannel,
} from "../managed-cli-guard";

const DEV3_HOME = "/Users/x/.dev3.0";

function verdict(over: Partial<Parameters<typeof mayWriteManagedCli>[0]> = {}) {
	return mayWriteManagedCli({
		buildChannel: "canary",
		execPath: "/opt/homebrew/Cellar/dev3/1.48.1/libexec/dev3",
		dev3Home: DEV3_HOME,
		platform: "darwin",
		env: {},
		...over,
	});
}

describe("mayWriteManagedCli", () => {
	it("lets an installed build own the shared CLI", () => {
		expect(verdict().write).toBe(true);
	});

	it("refuses a dev-channel build — the `bun run dev` bundle", () => {
		const v = verdict({ buildChannel: DEV_BUILD_CHANNEL });
		expect(v.write).toBe(false);
		expect(v.why).toContain("not an install");
	});

	it("refuses a source run, where execPath is the bun binary", () => {
		const v = verdict({ buildChannel: null, execPath: "/opt/homebrew/Cellar/bun/1.3.14/bin/bun" });
		expect(v.write).toBe(false);
		expect(v.why).toContain("running from source");
	});

	it("does NOT refuse the installed app's own bundled bun — a known channel decides first", () => {
		// The desktop app's main process IS a `bun` binary inside the bundle. If the
		// source check ran before the channel check, this guard would break the app
		// it exists to protect.
		expect(verdict({ buildChannel: "canary", execPath: "/Applications/dev-3.0.app/Contents/MacOS/bun" }).write).toBe(
			true,
		);
	});

	it("fails open when no channel can be read and the binary is a real install", () => {
		expect(verdict({ buildChannel: null }).write).toBe(true);
	});

	it("honours the explicit opt-in for a dev build, which does have a CLI to hand over", () => {
		expect(verdict({ buildChannel: DEV_BUILD_CHANNEL, env: { [MANAGED_CLI_OPT_IN_ENV]: "1" } }).write).toBe(true);
	});

	it("does not let the opt-in resurrect a source run — bun is not a CLI", () => {
		const v = verdict({
			buildChannel: null,
			execPath: "/opt/homebrew/Cellar/bun/1.3.14/bin/bun",
			env: { [MANAGED_CLI_OPT_IN_ENV]: "1" },
		});
		expect(v.write).toBe(false);
		expect(v.why).toContain("running from source");
	});

	it("treats anything other than exactly `1` as no opt-in", () => {
		for (const value of ["0", "", "true", "yes"]) {
			expect(verdict({ buildChannel: DEV_BUILD_CHANNEL, env: { [MANAGED_CLI_OPT_IN_ENV]: value } }).write).toBe(false);
		}
	});

	it("always says why, so a skipped install is never silent", () => {
		expect(verdict({ buildChannel: DEV_BUILD_CHANNEL }).why.length).toBeGreaterThan(10);
		expect(verdict().why.length).toBeGreaterThan(10);
	});
});

const roots: string[] = [];
function bundle(channel: string | null, name = "dev-3.0.app"): string {
	const root = mkdtempSync(join(tmpdir(), "dev3-guard-"));
	roots.push(root);
	const resources = join(root, name, "Contents", "Resources");
	mkdirSync(join(resources, "app", "cli"), { recursive: true });
	if (channel !== null) {
		writeFileSync(join(resources, "version.json"), JSON.stringify({ version: "1.48.1", channel }));
	}
	return join(resources, "app", "cli", "dev3");
}

afterAll(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe("resolveBuildChannel", () => {
	it("reads the channel from the Resources dir above the binary", () => {
		expect(resolveBuildChannel(bundle("dev", "dev-3.0-dev.app"))).toBe("dev");
		expect(resolveBuildChannel(bundle("canary"))).toBe("canary");
	});

	it("returns null when the bundle carries no version.json", () => {
		expect(resolveBuildChannel(bundle(null))).toBeNull();
	});

	it("returns null for a path with no Resources ancestor at all", () => {
		expect(resolveBuildChannel("/opt/homebrew/Cellar/dev3/1.48.1/libexec/dev3")).toBeNull();
	});

	it("returns null rather than throwing on a corrupt version.json", () => {
		const binary = bundle("canary");
		writeFileSync(join(binary, "..", "..", "..", "version.json"), "{ not json");
		expect(resolveBuildChannel(binary)).toBeNull();
	});

	it("terminates at the filesystem root instead of looping", () => {
		expect(resolveBuildChannel("/")).toBeNull();
	});
});
