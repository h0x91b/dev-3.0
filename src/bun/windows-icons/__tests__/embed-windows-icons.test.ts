import { describe, expect, it } from "vitest";
import { join } from "node:path";
import {
	assertIconsEmbedded,
	embedWindowsIcons,
	resolveIconTargets,
	WINDOWS_ICON_TARGETS,
	type IconTarget,
} from "../embed-windows-icons";
import { PE_WITH_ICON, PE_WITHOUT_ICON } from "./pe-fixture";

const BUNDLE_ROOT = join("build", "canary-win-x64", "dev-3.0-canary");

function absolute(relativePath: string): string {
	return join(BUNDLE_ROOT, ...relativePath.split("/"));
}

/** A bundle on disk: which paths exist, and what bytes each holds. */
function fakeBundle(files: Record<string, Uint8Array>) {
	return {
		exists: (path: string) => path in files,
		read: (path: string) => {
			const bytes = files[path];
			if (!bytes) throw new Error(`test bug: read of unstubbed path ${path}`);
			return bytes;
		},
	};
}

function iconlessBundle() {
	return fakeBundle(Object.fromEntries(WINDOWS_ICON_TARGETS.map((path) => [absolute(path), PE_WITHOUT_ICON()])));
}

describe("WINDOWS_ICON_TARGETS", () => {
	it("covers exactly the two executables a user sees, and not the installer", () => {
		expect(WINDOWS_ICON_TARGETS).toEqual(["bin/launcher.exe", "bin/bun.exe"]);
	});
});

describe("resolveIconTargets", () => {
	it("resolves every expected executable", () => {
		const targets = resolveIconTargets(BUNDLE_ROOT, iconlessBundle());
		expect(targets.map((target) => target.relativePath)).toEqual([...WINDOWS_ICON_TARGETS]);
		expect(targets[0].absolutePath).toBe(absolute("bin/launcher.exe"));
	});

	// The layout-drift case: a rename must read as a diagnosis, never as a proof
	// that quietly inspects one file instead of two.
	it("names the missing executable, the cause and the fix when the layout drifts", () => {
		const bundle = fakeBundle({ [absolute("bin/launcher.exe")]: PE_WITH_ICON() });
		expect(() => resolveIconTargets(BUNDLE_ROOT, bundle)).toThrow(
			/found 1 of 2 expected executables.*missing: bin\/bun\.exe.*Cause: the packaged bundle layout.*Fix: .*update WINDOWS_ICON_TARGETS/s,
		);
	});

	it("refuses an empty bundle rather than resolving nothing", () => {
		expect(() => resolveIconTargets(BUNDLE_ROOT, fakeBundle({}))).toThrow(/found 0 of 2 expected executables/);
	});
});

describe("assertIconsEmbedded", () => {
	it("passes when every executable carries an icon", () => {
		const bundle = fakeBundle(Object.fromEntries(WINDOWS_ICON_TARGETS.map((path) => [absolute(path), PE_WITH_ICON()])));
		expect(() => assertIconsEmbedded(resolveIconTargets(BUNDLE_ROOT, bundle), bundle)).not.toThrow();
	});

	it("names the iconless executable, the cause and the fix", () => {
		const bundle = fakeBundle({
			[absolute("bin/launcher.exe")]: PE_WITH_ICON(),
			[absolute("bin/bun.exe")]: PE_WITHOUT_ICON(),
		});
		expect(() => assertIconsEmbedded(resolveIconTargets(BUNDLE_ROOT, bundle), bundle)).toThrow(
			/No icon resource in bin\/bun\.exe.*Cause: rcedit did not write RT_ICON \+ RT_GROUP_ICON.*Fix: .*bun install --frozen-lockfile/s,
		);
	});

	// A verifier handed nothing loops zero times and reports success. That silent
	// pass is the failure this assertion exists to prevent, so it gets its own
	// message rather than falling through the per-file check.
	it("fails on an empty target list instead of passing vacuously", () => {
		expect(() => assertIconsEmbedded([], fakeBundle({}))).toThrow(
			/handed 0 executables but must inspect exactly 2 \(bin\/launcher\.exe, bin\/bun\.exe\).*would have verified nothing.*Fix: pass the full list from resolveIconTargets/s,
		);
	});

	it("fails on a short target list even when every file it was given is fine", () => {
		const bundle = fakeBundle({ [absolute("bin/launcher.exe")]: PE_WITH_ICON() });
		const partial: IconTarget[] = [{ relativePath: "bin/launcher.exe", absolutePath: absolute("bin/launcher.exe") }];
		expect(() => assertIconsEmbedded(partial, bundle)).toThrow(/handed 1 executables but must inspect exactly 2/);
	});
});

describe("embedWindowsIcons", () => {
	it("runs rcedit once per executable and returns what it proved", () => {
		const files = Object.fromEntries(WINDOWS_ICON_TARGETS.map((path) => [absolute(path), PE_WITHOUT_ICON()]));
		const bundle = fakeBundle(files);
		const calls: Array<{ rcedit: string; args: string[] }> = [];

		const proved = embedWindowsIcons({
			bundleRoot: BUNDLE_ROOT,
			icoPath: "/tmp/dev3.ico",
			rceditPath: "/rcedit-x64.exe",
			probe: bundle,
			run: (rcedit, args) => {
				calls.push({ rcedit, args });
				files[args[0]] = PE_WITH_ICON(); // what a working rcedit does
			},
		});

		expect(calls).toEqual([
			{ rcedit: "/rcedit-x64.exe", args: [absolute("bin/launcher.exe"), "--set-icon", "/tmp/dev3.ico"] },
			{ rcedit: "/rcedit-x64.exe", args: [absolute("bin/bun.exe"), "--set-icon", "/tmp/dev3.ico"] },
		]);
		expect(proved.map((target) => target.relativePath)).toEqual([...WINDOWS_ICON_TARGETS]);
	});

	// The exact upstream defect: rcedit "succeeds" and writes nothing.
	it("fails when rcedit exits cleanly without writing an icon", () => {
		const bundle = iconlessBundle();
		expect(() =>
			embedWindowsIcons({
				bundleRoot: BUNDLE_ROOT,
				icoPath: "/tmp/dev3.ico",
				rceditPath: "/rcedit-x64.exe",
				probe: bundle,
				run: () => {},
			}),
		).toThrow(/No icon resource in bin\/launcher\.exe, bin\/bun\.exe/);
	});

	it("propagates a failing rcedit instead of verifying stale bytes", () => {
		const bundle = iconlessBundle();
		expect(() =>
			embedWindowsIcons({
				bundleRoot: BUNDLE_ROOT,
				icoPath: "/tmp/dev3.ico",
				rceditPath: "/rcedit-x64.exe",
				probe: bundle,
				run: () => {
					throw new Error("rcedit exited with code 1");
				},
			}),
		).toThrow("rcedit exited with code 1");
	});
});
