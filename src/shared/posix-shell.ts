/**
 * Which POSIX shell dev3 runs, and where it lives.
 *
 * dev3 grew up on macOS, where `/bin/zsh` always exists. A minimal Linux box
 * may ship neither zsh nor bash — only a POSIX `sh` (usually dash or busybox
 * ash). Every hardcoded `/bin/zsh` is a dead terminal there, so the choice
 * lives in one pure resolver and the app-level `terminalShell` setting feeds
 * it.
 *
 * Pure on purpose: filesystem probing is injected, so the whole decision table
 * is unit-testable without touching a real machine.
 */

/** The three shell dialects dev3 knows how to configure. */
export type ShellFlavor = "zsh" | "bash" | "sh";

/** Preference order when nothing usable is named. zsh first keeps macOS as-is. */
export const SHELL_FALLBACK_ORDER: readonly ShellFlavor[] = ["zsh", "bash", "sh"];

/**
 * Absolute paths probed for each flavor, in order. No PATH lookup: this runs
 * during boot, before the user's PATH has been resolved from their login shell.
 */
const SHELL_CANDIDATE_PATHS: Record<ShellFlavor, readonly string[]> = {
	zsh: ["/bin/zsh", "/usr/bin/zsh", "/usr/local/bin/zsh", "/opt/homebrew/bin/zsh"],
	bash: ["/bin/bash", "/usr/bin/bash", "/usr/local/bin/bash", "/opt/homebrew/bin/bash"],
	sh: ["/bin/sh", "/usr/bin/sh"],
};

/**
 * Binary names that are a POSIX `sh` for our purposes. dash and ash are what
 * `/bin/sh` actually is on Debian/Ubuntu and on busybox systems.
 */
const SH_ALIASES = new Set(["sh", "dash", "ash", "busybox"]);

/** Map a shell path to the dialect dev3 configures, or null when unknown (fish, nu, …). */
export function shellFlavorOf(shellPath: string | null | undefined): ShellFlavor | null {
	if (!shellPath) return null;
	// A login shell is sometimes recorded as `-zsh`; strip the login dash too.
	const name = shellPath.trim().split("/").pop()?.replace(/^-/, "") ?? "";
	if (name === "zsh") return "zsh";
	if (name === "bash") return "bash";
	if (SH_ALIASES.has(name)) return "sh";
	return null;
}

export function shellCandidatePaths(flavor: ShellFlavor): readonly string[] {
	return SHELL_CANDIDATE_PATHS[flavor];
}

export interface PosixShellResolution {
	/** Absolute path of the shell to run. */
	path: string;
	/** Dialect of {@link path}; null for a shell dev3 does not configure (fish, …). */
	flavor: ShellFlavor | null;
	/** What was asked for: an explicit setting, or `"auto"` for detection. */
	requested: ShellFlavor | "auto";
	/** True when the explicitly requested flavor was not installed. */
	fellBack: boolean;
}

export interface ResolvePosixShellOptions {
	/** The `terminalShell` setting; undefined means auto-detect. */
	preference?: ShellFlavor;
	/** Login shell from the account database (dscl / getent). */
	accountShell?: string | null;
	/** `$SHELL` of the dev3 process. */
	envShell?: string | null;
	/** Existence + executability probe for an absolute path. */
	exists: (path: string) => boolean;
}

/** Last resort: POSIX guarantees `/bin/sh`, nothing else. */
const LAST_RESORT_SHELL = "/bin/sh";

function firstExisting(paths: readonly string[], exists: (path: string) => boolean): string | null {
	return paths.find((candidate) => exists(candidate)) ?? null;
}

function resolveFlavor(flavor: ShellFlavor, opts: ResolvePosixShellOptions): string | null {
	// A shell the user already runs wins over the canonical path, so a homebrew
	// zsh or a custom-prefix bash keeps being the one that starts.
	for (const known of [opts.accountShell, opts.envShell]) {
		if (known && shellFlavorOf(known) === flavor && opts.exists(known)) return known;
	}
	return firstExisting(SHELL_CANDIDATE_PATHS[flavor], opts.exists);
}

/**
 * Decide which shell binary dev3 runs.
 *
 * Explicit preference → that flavor, falling back down {@link SHELL_FALLBACK_ORDER}
 * when it is not installed (`fellBack: true`). Auto → the user's own login shell
 * when it exists, even if dev3 does not know its dialect (a fish user keeps fish),
 * otherwise the first installed flavor in the fallback order.
 */
export function resolvePosixShell(opts: ResolvePosixShellOptions): PosixShellResolution {
	if (opts.preference) {
		const direct = resolveFlavor(opts.preference, opts);
		if (direct) return { path: direct, flavor: opts.preference, requested: opts.preference, fellBack: false };
		for (const flavor of SHELL_FALLBACK_ORDER) {
			if (flavor === opts.preference) continue;
			const path = resolveFlavor(flavor, opts);
			if (path) return { path, flavor, requested: opts.preference, fellBack: true };
		}
		return { path: LAST_RESORT_SHELL, flavor: "sh", requested: opts.preference, fellBack: true };
	}

	for (const known of [opts.accountShell, opts.envShell]) {
		if (known?.trim() && opts.exists(known)) {
			return { path: known, flavor: shellFlavorOf(known), requested: "auto", fellBack: false };
		}
	}
	for (const flavor of SHELL_FALLBACK_ORDER) {
		const path = resolveFlavor(flavor, opts);
		if (path) return { path, flavor, requested: "auto", fellBack: false };
	}
	return { path: LAST_RESORT_SHELL, flavor: "sh", requested: "auto", fellBack: false };
}
