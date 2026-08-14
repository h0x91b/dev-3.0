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
/**
 * Changed files matching any of these dispatch the packaged Windows workflow.
 *
 * THIS LIST IS A UNION OF TWO INVARIANTS, not one, and every entry is tagged with the
 * one that earned it:
 *   (1) SHIPS INTO / IS EXERCISED BY the packaged Windows proof — change it and the
 *       packaged Windows app itself may differ.
 *   (2) CARRIES THE BUN PIN that every workflow must hold in lockstep — drift there means
 *       the repo's pins no longer agree, so the packaged proof stops being evidence about
 *       the runtime anyone actually ships. This is why `electrobun.config.ts` and
 *       `package.json` are here even though neither builds Windows.
 *
 * An entry may only be deleted by defeating the SPECIFIC reason that earned it. Deleting
 * one because the other reason does not apply is how coverage silently disappears.
 */
export const WINDOWS_SCOPE_PATHS = [
	// (1) the proof itself
	".github/workflows/windows-conpty-package.yml",
	// The post-merge caller. RULE: a workflow that DISPATCHES the proof must itself be
	// in this list — it pins Bun, a pin change is a packaged-runtime change, and a
	// workflow outside the list cannot dispatch the proof for its own edits.
	".github/workflows/windows-proof-main.yml",
	// The hourly canary publisher. In under BOTH criteria: it dispatches the proof (same
	// rule as the line above) and it pins Bun for the builds it calls.
	".github/workflows/canary-publish.yml",
	// (2) these carry the Bun pin that builds and ships the app, so a pin change here is
	// a packaged-runtime change and the proof has to re-run. release.yml still pins Bun in
	// its `prepare` and `release` jobs after the per-platform builds moved out; the two
	// reusable build workflows below pin it for the builds themselves. NOTE that the
	// reusable files are in under (2) ONLY — release.yml packages nothing itself: it CALLS the
	// proof and (since windows-zip-on-the-release-page.md) the Windows build leg, so nothing in
	// it ships into the packaged Windows app.
	".github/workflows/build.yml",
	".github/workflows/release.yml",
	".github/workflows/release-build-macos.yml",
	".github/workflows/release-build-linux.yml",
	// The Windows leg, and unlike its two siblings above it is in under BOTH criteria: it pins
	// Bun AND it is the only workflow that packages the app a Windows user installs. An edit
	// here changes the shipped Windows build directly, so it must re-run the proof.
	".github/workflows/release-build-windows.yml",
	".github/workflows/native-terminal-soak.yml",
	"electrobun.config.ts",
	"package.json",
	"scripts/fixtures/windows-conpty-package/**",
	"scripts/build-cli.ts",
	"scripts/build-native.ts",
	"scripts/build-terminal-host.ts",
	"scripts/package-native-host.ts",
	"scripts/package-posix-native-host.ts",
	"scripts/package-windows-launched-tree.ts",
	// The prose that ships WITH the Windows download — the unsigned-launch warning and the entry
	// point, rendered into both the run summary and the release body. Under (1): a break here
	// reaches a human as wrong instructions for a build nothing else describes.
	"scripts/windows-release-notes.ts",
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
	// The Codex config dev3 writes into ~/.codex/config.toml. A raw Windows path in a
	// TOML basic string killed codex machine-wide (Seq 1540); only a Windows run proves
	// the generated file parses, so an edit here must re-dispatch the proof.
	"src/bun/codex-config.ts",
	"src/bun/__tests__/codex-config-windows-paths.test.ts",
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
