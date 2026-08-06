/**
 * Embeds the app icon into the Windows executables a human actually receives, and
 * then PROVES it landed by reading the resource table back out of each file.
 *
 * Electrobun does this itself and cannot: its CLI ships as a `bun --compile`
 * standalone whose `require.resolve("rcedit/package.json")` was frozen to the
 * builder's own CI path, so the call fails on every other machine and is swallowed
 * by a `console.warn`. See `decisions/2026/08/06/vendor-rcedit-for-windows-icons.md`.
 */
import { join } from "node:path";
import { hasEmbeddedIcon } from "./pe-icon-resources";

/**
 * Bundle-relative paths of the executables whose icon a user sees. Electrobun's
 * non-macOS layout puts every executable in `bin/`; `launcher.exe` is what the
 * user starts and `bun.exe` is the runtime that owns the window.
 *
 * The self-extracting installer is deliberately absent: it is built after this
 * hook runs, from electrobun's own extractor stub, and
 * `decisions/2026/08/06/downloadable-windows-build-is-the-launched-tree.md` records that
 * it is never launched by anything and is not handed out. Giving the unproven
 * artifact an icon would make it read as vetted.
 *
 * Consequence to expect in every Windows build log, permanently: electrobun emits
 * THREE `Failed to embed icon` warnings, and this hook removes NONE of them —
 * electrobun tries first and warns on the way past, and we repair two of the three
 * afterwards. A build that worked still prints all three. That is why the hook's
 * success line says the earlier warnings are superseded instead of only announcing
 * itself; a log that reads as broken while being correct is a defect.
 *
 * The third, for the installer, is the decision above — do not "finish the job" by
 * reaching into the zip electrobun just wrote.
 */
export const WINDOWS_ICON_TARGETS = ["bin/launcher.exe", "bin/bun.exe"] as const;

export interface IconTarget {
	/** Bundle-relative, POSIX-separated. */
	relativePath: string;
	absolutePath: string;
}

export interface IconTargetProbe {
	exists(absolutePath: string): boolean;
}

export interface IconVerificationProbe {
	read(absolutePath: string): Uint8Array;
}

/**
 * Resolves every expected target, or throws. A resolver that can return fewer
 * targets than expected turns a rename or a layout change into a proof that
 * inspects nothing and reports success, so the count is asserted here rather than
 * left to the caller.
 */
export function resolveIconTargets(bundleRoot: string, probe: IconTargetProbe): IconTarget[] {
	const targets: IconTarget[] = [];
	const missing: string[] = [];
	for (const relativePath of WINDOWS_ICON_TARGETS) {
		const absolutePath = join(bundleRoot, ...relativePath.split("/"));
		if (probe.exists(absolutePath)) targets.push({ relativePath, absolutePath });
		else missing.push(relativePath);
	}

	if (missing.length > 0) {
		throw new Error(
			`Windows icon embedding found ${targets.length} of ${WINDOWS_ICON_TARGETS.length} expected executables under ${bundleRoot}; ` +
				`missing: ${missing.join(", ")}. ` +
				"Cause: the packaged bundle layout no longer matches WINDOWS_ICON_TARGETS (a rename, or a build that did not finish). " +
				"Fix: re-check electrobun's bundle layout and update WINDOWS_ICON_TARGETS in src/bun/windows-icons/embed-windows-icons.ts.",
		);
	}
	return targets;
}

/**
 * Fails unless EVERY expected executable carries an icon resource — including the
 * case where the caller hands over an empty list, which would otherwise loop zero
 * times and pass.
 */
export function assertIconsEmbedded(targets: IconTarget[], probe: IconVerificationProbe): void {
	if (targets.length !== WINDOWS_ICON_TARGETS.length) {
		throw new Error(
			`Windows icon proof was handed ${targets.length} executables but must inspect exactly ${WINDOWS_ICON_TARGETS.length} ` +
				`(${WINDOWS_ICON_TARGETS.join(", ")}). ` +
				"Cause: the target list was filtered or built from a stale layout, so the proof would have verified nothing. " +
				"Fix: pass the full list from resolveIconTargets().",
		);
	}

	const iconless = targets.filter((target) => !hasEmbeddedIcon(probe.read(target.absolutePath)));
	if (iconless.length > 0) {
		throw new Error(
			`No icon resource in ${iconless.map((target) => target.relativePath).join(", ")}. ` +
				"Cause: rcedit did not write RT_ICON + RT_GROUP_ICON into the executable, so Windows shows the default icon. " +
				"Fix: check the rcedit invocation in src/bun/windows-icons/embed-windows-icons.ts and that `rcedit` is installed (`bun install --frozen-lockfile`).",
		);
	}
}

export interface EmbedOptions {
	bundleRoot: string;
	/** Absolute path to a `.ico` file. */
	icoPath: string;
	/** Absolute path to `rcedit-x64.exe`. */
	rceditPath: string;
	probe: IconTargetProbe & IconVerificationProbe;
	/** Runs rcedit; must throw on a non-zero exit. */
	run(rceditPath: string, args: string[]): void;
}

/** Embed, then verify. Returns the targets proved to carry an icon. */
export function embedWindowsIcons(options: EmbedOptions): IconTarget[] {
	const targets = resolveIconTargets(options.bundleRoot, options.probe);
	for (const target of targets) {
		options.run(options.rceditPath, [target.absolutePath, "--set-icon", options.icoPath]);
	}
	assertIconsEmbedded(targets, options.probe);
	return targets;
}
