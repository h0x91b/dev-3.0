/**
 * Single source of truth for whether a pull request puts the packaged Windows
 * proof in scope.
 *
 * The list used to live in `windows-conpty-package.yml` as an `on.pull_request.paths`
 * filter. It moved here because the required contexts now wait on that workflow:
 * a filter GitHub evaluates for itself cannot be read by a gate, and a second copy
 * of a 45-entry list would drift with nobody knowing which copy was authoritative.
 *
 * THIS LIST IS LOAD-BEARING. Before, a missing entry meant Windows quietly did not
 * run. Now a missing entry makes the required `test` context assert "deliberately
 * out of scope" — a stronger claim built on the same fragile list. See decisions/209.
 */

/** Changed files matching any of these dispatch the packaged Windows workflow. */
export const WINDOWS_SCOPE_PATHS = [
	".github/workflows/windows-conpty-package.yml",
	// A Bun pin change in these is a packaged-runtime change: they install the
	// Bun that builds and ships the app, so the package proof has to re-run.
	".github/workflows/build.yml",
	".github/workflows/release.yml",
	".github/workflows/native-terminal-soak.yml",
	"electrobun.config.ts",
	"package.json",
	"scripts/fixtures/windows-conpty-package/**",
	"scripts/build-cli.ts",
	"scripts/build-native.ts",
	"scripts/build-terminal-host.ts",
	"scripts/package-native-host.ts",
	"scripts/package-posix-native-host.ts",
	"scripts/verify-packaged-windows-conpty.ts",
	"scripts/verify-windows-app-launch.ts",
	"scripts/verify-windows-conpty-update-archive.ts",
	"src/bun/app-ready-marker.ts",
	"src/bun/renderer-readiness.ts",
	"src/bun/index.ts",
	"scripts/native-terminal-host-manifest/**",
	"src/bun/native-terminal-host/**",
	"src/bun/native-task-terminal.ts",
	"src/bun/native-host-runtime.ts",
	"src/bun/task-terminal-backend.ts",
	"src/bun/pty-server.ts",
	"src/shared/resize-protocol.ts",
	"src/bun/__tests__/native-task-terminal.bun-e2e.ts",
	"src/bun/__tests__/native-task-terminal-controller.ts",
	"src/shared/native-terminal-runtime.ts",
	"src/bun/prototypes/detached-pty/**",
	"src/bun/native-terminal-registry/**",
	"src/bun/native-terminal-multipane/**",
	"src/bun/native-terminal-adapter/**",
	"src/bun/terminal-parity/**",
	// Windows CLI control transport (seq 1296): both loopback E2E steps.
	"src/shared/cli-endpoint.ts",
	"src/bun/cli-listener.ts",
	"src/bun/cli-socket-server.ts",
	"src/bun/cli-self-install.ts",
	"src/bun/instance-broadcast.ts",
	"src/cli/context.ts",
	"src/cli/socket-client.ts",
	"src/bun/__tests__/cli-loopback-transport.bun-e2e.ts",
	"src/cli/__tests__/cli-packaged-loopback.bun-e2e.ts",
	// This list and the script reading it decide the whole thing; changing either
	// has to re-prove Windows rather than judging its own change out of scope.
	"src/shared/windows-ci-scope.ts",
	"scripts/windows-ci-scope.ts",
] as const;

function toRegExp(pattern: string): RegExp {
	const source = pattern
		.split("**")
		.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replaceAll("\\*", "[^/]*"))
		.join(".*");
	return new RegExp(`^${source}$`);
}

const MATCHERS = WINDOWS_SCOPE_PATHS.map(toRegExp);

/** True when one repo-relative path (POSIX separators) is in Windows packaging scope. */
export function matchesWindowsScope(file: string): boolean {
	return MATCHERS.some((matcher) => matcher.test(file));
}

/** The changed files that put Windows in scope — empty means out of scope. */
export function windowsScopeHits(files: readonly string[]): string[] {
	return files.filter((file) => matchesWindowsScope(file));
}
