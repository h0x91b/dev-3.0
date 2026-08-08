/**
 * The vendor patch that lets `electrobun build --env=unstable` mean what it says.
 *
 * WHY A PATCH AT ALL. electrobun's CLI gates `--env` on a three-element allowlist and
 * SILENTLY falls back to `dev` on anything else, while every layer below it is already
 * channel-generic (`getAppFileName`, `getPlatformPrefix`, the DMG volume name, the patch
 * naming) and its own type is `BuildEnvironment = "stable" | "canary" | "dev" | (string & {})`
 * — it explicitly admits arbitrary strings. So this is not extending electrobun; it is
 * removing a check that contradicts electrobun's own type.
 *
 * WHY THIS TEST EXISTS. The failure mode of a lapsed patch is invisible: `--env=unstable`
 * hits the allowlist, degrades to `dev`, and the release publishes a DEV build wearing an
 * unstable name — polling the wrong feed, with nothing in any log saying so. So a lapse must
 * be RED here rather than discovered by a user who stops receiving updates.
 *
 * This is one of TWO assertions, deliberately. This one proves the patch is applied to the
 * installed dependency; the release workflow separately proves the BUILT ARTIFACT's
 * version.json says `unstable`, because this can pass while that fails for an unrelated
 * reason. See decisions/2026/08/06/stable-unstable-update-channels.md.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const CLI_SOURCE = resolve(repoRoot, "node_modules/electrobun/src/cli/index.ts");
const PACKAGE_JSON = resolve(repoRoot, "package.json");

/** The `--env` allowlist, read out of the INSTALLED dependency rather than the patch file. */
function installedChannelAllowlist(): string[] {
	const source = readFileSync(CLI_SOURCE, "utf8");
	const match = source.match(/const buildEnvironment = \[([^\]]*)\]\s*\.?includes/s);
	if (!match) return [];
	return [...match[1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
}

describe("the electrobun --env allowlist patch", () => {
	it("is declared in package.json for the exact installed version", () => {
		const pkg = JSON.parse(readFileSync(PACKAGE_JSON, "utf8")) as {
			dependencies?: Record<string, string>;
			devDependencies?: Record<string, string>;
			patchedDependencies?: Record<string, string>;
		};
		const version = pkg.devDependencies?.electrobun ?? pkg.dependencies?.electrobun;
		const patched = pkg.patchedDependencies ?? {};
		expect(
			patched[`electrobun@${version}`],
			`package.json pins electrobun@${version} but declares no patch for that exact version. An electrobun UPGRADE is the likely cause: bun silently stops applying a patch keyed to the old version, --env=unstable degrades to a dev build, and the unstable feed publishes a dev bundle that polls the wrong channel. Fix: re-create the patch against the new version (bun patch electrobun, add "unstable" to the --env allowlist in src/cli/index.ts, bun patch --commit node_modules/electrobun), or delete this patch entirely if electrobun now accepts arbitrary channel strings.`,
		).toBeTruthy();
		expect(existsSync(resolve(repoRoot, patched[`electrobun@${version}`] ?? "")))
			.toBe(true);
	});

	it("is actually applied to the installed dependency, not merely declared", () => {
		const allowlist = installedChannelAllowlist();
		expect(
			allowlist,
			`could not find the --env allowlist in ${CLI_SOURCE}. electrobun restructured that code, so this guard is now vacuous and the patch may be silently unapplied. Fix: re-read src/cli/index.ts, point this parser at the new shape, and re-verify the patch.`,
		).not.toHaveLength(0);
		expect(
			allowlist,
			`the installed electrobun does NOT accept --env=unstable; it will silently fall back to "dev". That publishes a DEV build under an unstable name: it polls the wrong feed and no log says so. Likely cause: an electrobun upgrade dropped the patch. Fix: re-apply it (bun patch electrobun → add "unstable" → bun patch --commit).`,
		).toContain("unstable");
	});

	it("still admits the channels electrobun shipped, so the patch only ADDS", () => {
		// A patch that replaced the list instead of extending it would break stable releases,
		// and stable is the channel almost everyone is on.
		expect(installedChannelAllowlist()).toEqual(expect.arrayContaining(["dev", "canary", "stable"]));
	});
});
