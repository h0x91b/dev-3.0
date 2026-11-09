import { describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	type BinaryCacheLayout,
	KEPT_VERSIONS,
	binaryCacheRoot,
	restoreElectrobunBinaries,
	storeElectrobunBinaries,
} from "../../../scripts/electrobun-binary-cache";
import { testScopedPath } from "../../../test-scoped-path";

const BUN = "1.3.14";
const LONG_AGO = new Date("2020-01-01T00:00:00Z");

function write(path: string, content: string, mode = 0o644): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content);
	chmodSync(path, mode);
}

const read = (path: string) => readFileSync(path, "utf-8");
const packageDir = (layout: BinaryCacheLayout) => join(layout.nodeModules, "electrobun");
const bunOverride = (layout: BinaryCacheLayout) => join(layout.nodeModules, ".electrobun-cache", "bun-override", "macos-arm64");

/** A checkout right after `bun install`: the package is there, its downloads are not. */
function freshCheckout(root: string, name: string, version = "1.18.1"): BinaryCacheLayout {
	const layout = { nodeModules: join(root, name, "node_modules"), cacheRoot: join(root, "cache"), host: "darwin-arm64" };
	write(join(packageDir(layout), "package.json"), JSON.stringify({ version }));
	// Ships in the npm package, so it is present before any download.
	write(join(packageDir(layout), "dist", "main.js"), "shared");
	return layout;
}

function addBunOverride(layout: BinaryCacheLayout, version: string, content = `bun ${version}`): void {
	write(join(bunOverride(layout), "bun"), content, 0o755);
	write(join(bunOverride(layout), ".bun-version"), version);
}

/** The same checkout after a successful `electrobun build` downloaded everything. */
function builtCheckout(root: string, name: string, version = "1.18.1"): BinaryCacheLayout {
	const layout = freshCheckout(root, name, version);
	write(join(packageDir(layout), "bin", "electrobun"), `cli ${version}`, 0o755);
	write(join(packageDir(layout), "dist-macos-arm64", "launcher"), `launcher ${version}`, 0o755);
	addBunOverride(layout, BUN);
	return layout;
}

describe("binaryCacheRoot", () => {
	it("follows each platform's own cache convention", () => {
		expect([
			binaryCacheRoot({}, "darwin", "/home/u"),
			binaryCacheRoot({}, "linux", "/home/u"),
			binaryCacheRoot({ XDG_CACHE_HOME: "/xdg" }, "linux", "/home/u"),
			binaryCacheRoot({ LOCALAPPDATA: "/local" }, "win32", "/home/u"),
		]).toEqual([
			join("/home/u", "Library", "Caches", "dev3-electrobun"),
			join("/home/u", ".cache", "dev3-electrobun"),
			join("/xdg", "dev3-electrobun"),
			join("/local", "dev3-electrobun"),
		]);
	});

	it("lets DEV3_ELECTROBUN_CACHE_DIR override the platform default", () => {
		expect(binaryCacheRoot({ DEV3_ELECTROBUN_CACHE_DIR: "/elsewhere" }, "darwin", "/home/u")).toBe("/elsewhere");
	});
});

describe("electrobun binary cache", () => {
	it("hands a fresh checkout what another checkout's build downloaded", () => {
		const root = testScopedPath("round-trip");
		storeElectrobunBinaries(builtCheckout(root, "built"));
		const fresh = freshCheckout(root, "fresh");

		restoreElectrobunBinaries(fresh, BUN);

		expect([
			read(join(packageDir(fresh), "bin", "electrobun")),
			read(join(packageDir(fresh), "dist-macos-arm64", "launcher")),
			read(join(bunOverride(fresh), "bun")),
		]).toEqual(["cli 1.18.1", "launcher 1.18.1", `bun ${BUN}`]);
	});

	it("reports what it stored and what it restored", () => {
		const root = testScopedPath("report");
		const stored = storeElectrobunBinaries(builtCheckout(root, "built"));
		const restored = restoreElectrobunBinaries(freshCheckout(root, "fresh"), BUN);

		expect({ stored, restored }).toEqual({
			stored: ["electrobun 1.18.1", `bun ${BUN} (macos-arm64)`],
			restored: ["bin/electrobun", "dist-macos-arm64", `bun ${BUN} (macos-arm64)`],
		});
	});

	it.skipIf(process.platform === "win32")("keeps the restored CLI executable", () => {
		const root = testScopedPath("exec-bit");
		storeElectrobunBinaries(builtCheckout(root, "built"));
		const fresh = freshCheckout(root, "fresh");

		restoreElectrobunBinaries(fresh, BUN);

		expect(statSync(join(packageDir(fresh), "bin", "electrobun")).mode & 0o111).toBe(0o111);
	});

	it("restores nothing for an electrobun version it has never stored", () => {
		const root = testScopedPath("new-version");
		storeElectrobunBinaries(builtCheckout(root, "built", "1.18.1"));
		const bumped = freshCheckout(root, "bumped", "1.19.0");

		restoreElectrobunBinaries(bumped, undefined);

		// The gap is what makes electrobun download the new version itself.
		expect(existsSync(join(packageDir(bumped), "bin", "electrobun"))).toBe(false);
	});

	it("never overwrites a binary the checkout already has", () => {
		const root = testScopedPath("no-overwrite");
		storeElectrobunBinaries(builtCheckout(root, "built"));
		const partial = freshCheckout(root, "partial");
		write(join(packageDir(partial), "bin", "electrobun"), "downloaded here", 0o755);

		restoreElectrobunBinaries(partial, BUN);

		expect(read(join(packageDir(partial), "bin", "electrobun"))).toBe("downloaded here");
	});

	it("still fills the gaps next to a binary the checkout already has", () => {
		const root = testScopedPath("fill-gaps");
		storeElectrobunBinaries(builtCheckout(root, "built"));
		const partial = freshCheckout(root, "partial");
		write(join(packageDir(partial), "bin", "electrobun"), "downloaded here", 0o755);

		restoreElectrobunBinaries(partial, BUN);

		expect(read(join(packageDir(partial), "dist-macos-arm64", "launcher"))).toBe("launcher 1.18.1");
	});

	it("does not share binaries across hosts", () => {
		const root = testScopedPath("hosts");
		storeElectrobunBinaries(builtCheckout(root, "built"));
		const otherHost = { ...freshCheckout(root, "fresh"), host: "linux-x64" };

		expect(restoreElectrobunBinaries(otherHost, undefined)).toEqual([]);
	});

	it("leaves the npm-shipped dist/ out of the snapshot", () => {
		const root = testScopedPath("shared-dist");
		const built = builtCheckout(root, "built");

		storeElectrobunBinaries(built);

		expect(existsSync(join(built.cacheRoot, "electrobun", "1.18.1", "darwin-arm64", "dist"))).toBe(false);
	});

	it("does not snapshot a checkout that is missing half the downloads", () => {
		const root = testScopedPath("incomplete");
		const cliOnly = freshCheckout(root, "cli-only");
		write(join(packageDir(cliOnly), "bin", "electrobun"), "cli 1.18.1", 0o755);

		expect(storeElectrobunBinaries(cliOnly)).toEqual([]);
	});

	it("keeps the first snapshot of a version instead of rewriting it", () => {
		const root = testScopedPath("write-once");
		storeElectrobunBinaries(builtCheckout(root, "first"));
		const second = builtCheckout(root, "second");
		write(join(packageDir(second), "bin", "electrobun"), "a later download", 0o755);
		storeElectrobunBinaries(second);
		const fresh = freshCheckout(root, "fresh");

		restoreElectrobunBinaries(fresh, undefined);

		expect(read(join(packageDir(fresh), "bin", "electrobun"))).toBe("cli 1.18.1");
	});

	it("refuses a version that is not a plain directory name", () => {
		const root = testScopedPath("unsafe-version");
		const hostile = builtCheckout(root, "hostile", "../../escaped");

		expect(storeElectrobunBinaries(hostile)).toEqual([`bun ${BUN} (macos-arm64)`]);
	});
});

describe("bun override cache", () => {
	it("replaces an override of the wrong version with the wanted one", () => {
		const root = testScopedPath("bun-mismatch");
		storeElectrobunBinaries(builtCheckout(root, "built"));
		const stale = freshCheckout(root, "stale");
		addBunOverride(stale, "1.2.0");

		restoreElectrobunBinaries(stale, BUN);

		expect([read(join(bunOverride(stale), ".bun-version")), read(join(bunOverride(stale), "bun"))]).toEqual([BUN, `bun ${BUN}`]);
	});

	it("leaves an override of the wanted version alone", () => {
		const root = testScopedPath("bun-match");
		storeElectrobunBinaries(builtCheckout(root, "built"));
		const current = freshCheckout(root, "current");
		addBunOverride(current, BUN, "downloaded here");

		restoreElectrobunBinaries(current, BUN);

		expect(read(join(bunOverride(current), "bun"))).toBe("downloaded here");
	});

	it("keeps an override it cannot replace with the wanted version", () => {
		const root = testScopedPath("bun-unknown");
		storeElectrobunBinaries(builtCheckout(root, "built"));
		const other = freshCheckout(root, "other");
		addBunOverride(other, "1.2.0");

		restoreElectrobunBinaries(other, "1.4.0");

		expect(read(join(bunOverride(other), ".bun-version"))).toBe("1.2.0");
	});

	it("does not snapshot a download electrobun never finished stamping", () => {
		const root = testScopedPath("bun-unstamped");
		const interrupted = freshCheckout(root, "interrupted");
		write(join(bunOverride(interrupted), "bun"), "half a binary", 0o755);

		expect(storeElectrobunBinaries(interrupted)).toEqual([]);
	});

	it("ignores another process's half-written snapshot", () => {
		const root = testScopedPath("bun-staging");
		const fresh = freshCheckout(root, "fresh");
		write(join(fresh.cacheRoot, "bun-override", BUN, "macos-arm64.staging-4242", "bun"), "half a copy");

		expect(restoreElectrobunBinaries(fresh, BUN)).toEqual([]);
	});
});

describe("binary cache housekeeping", () => {
	const versionDir = (layout: BinaryCacheLayout, version: string) => join(layout.cacheRoot, "electrobun", version);

	it("drops the least recently used version once a newer one exceeds the cap", () => {
		const root = testScopedPath("prune");
		const versions = Array.from({ length: KEPT_VERSIONS + 1 }, (_, i) => `1.0.${i}`);
		let cache = "";
		for (const [age, version] of versions.entries()) {
			const built = builtCheckout(root, version, version);
			cache = built.cacheRoot;
			storeElectrobunBinaries(built);
			// The last one keeps its real "just stored" time, the rest get ordered pasts.
			if (age < KEPT_VERSIONS) utimesSync(versionDir(built, version), new Date(LONG_AGO.getTime() + age * 1000), new Date(LONG_AGO.getTime() + age * 1000));
		}

		expect(versions.map((version) => existsSync(join(cache, "electrobun", version)))).toEqual([false, true, true, true]);
	});

	it("counts a restore as use, so a version still being checked out survives pruning", () => {
		const root = testScopedPath("lru-touch");
		const built = builtCheckout(root, "built");
		storeElectrobunBinaries(built);
		utimesSync(versionDir(built, "1.18.1"), LONG_AGO, LONG_AGO);

		restoreElectrobunBinaries(freshCheckout(root, "fresh"), undefined);

		expect(statSync(versionDir(built, "1.18.1")).mtimeMs).toBeGreaterThan(LONG_AGO.getTime());
	});

	it("reports an unusable cache instead of failing the build", () => {
		const root = testScopedPath("unusable");
		const built = builtCheckout(root, "built");
		// A file where the cache directory should be: nothing can be created under it.
		write(built.cacheRoot, "not a directory");
		const warnings: string[] = [];

		const stored = storeElectrobunBinaries(built, (message) => warnings.push(message));

		expect({ stored, warned: warnings.length }).toEqual({ stored: [], warned: 1 });
	});
});
