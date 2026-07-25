import type { RequirementCheckResult } from "./types";

/**
 * The binaries dev3 checks for at startup.
 *
 * Windows differs on both entries, and neither difference is cosmetic:
 *  - The install hints ARE commands, and `xcode-select` / `brew` do not exist
 *    there. `winget` ships with Windows 10+.
 *  - tmux cannot be installed on Windows at all, so a REQUIRED tmux makes the
 *    requirements gate permanently unpassable and the whole app unreachable. It
 *    stays listed — the renderer still shows it as missing, nothing is hidden —
 *    but `optional`, which is precisely what that flag means: does not block the
 *    app. A Windows task terminal runs on the native backend instead.
 */
export function getSystemRequirements(platform: NodeJS.Platform = process.platform): RequirementCheckResult[] {
	const windows = platform === "win32";
	return [
		{
			id: "git",
			name: "Git",
			installed: false,
			installHint: windows ? "requirements.installGitWindows" : "requirements.installGit",
			installCommand: windows ? "winget install --id Git.Git -e" : "xcode-select --install",
			brewInstallable: false,
		},
		{
			id: "tmux",
			name: "tmux",
			installed: false,
			installHint: windows ? "requirements.tmuxUnavailableWindows" : "requirements.installTmux",
			installCommand: windows ? undefined : "brew install h0x91b/dev3/tmux@3.6",
			brewInstallable: !windows,
			optional: windows,
		},
	];
}
