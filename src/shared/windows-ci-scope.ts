/**
 * Single source of truth for whether a change puts the packaged Windows proof in scope.
 *
 * The list used to live in `windows-conpty-package.yml` as an `on.pull_request.paths`
 * filter. It moved here so a gate could read it, back when the required `test` context
 * waited on that workflow. It no longer does: the proof runs POST-MERGE on `main` and
 * this list decides which pushes dispatch it.
 *
 * The list is still what stands between a Windows regression and nobody noticing, but
 * its failure mode is back to the mild one: a missing entry means "Windows was not
 * proved on this merge", not a required context asserting Windows was checked. See
 * decisions/2026/08/06/windows-proof-post-merge-not-pull-request.md.
 */
/** Changed files matching any of these dispatch the packaged Windows workflow. */
export const WINDOWS_SCOPE_PATHS = [
	".github/workflows/windows-conpty-package.yml",
	// The post-merge caller. RULE: a workflow that DISPATCHES the proof must itself be
	// in this list — it pins Bun, a pin change is a packaged-runtime change, and a
	// workflow outside the list cannot dispatch the proof for its own edits.
	".github/workflows/windows-proof-main.yml",
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
