/**
 * Whether an Electrobun build environment emits a distribution archive.
 *
 * Electrobun runs the `postPackage` hook for every environment, but only a
 * release-shaped build produces the `.tar.zst` update archive; `dev` produces a
 * build tree and nothing else. The Windows archive proof needs that distinction
 * so a plain `bun run dev` is not failed by a missing artifact.
 *
 * The check is deliberately one-sided: `dev` is the only environment KNOWN to
 * emit nothing, and everything else — including an unset value and Electrobun's
 * open-ended `BuildEnvironment` string — stays strict. An unset value then fails
 * inside the proof with its own explicit "requires ELECTROBUN_BUILD_ENV" error.
 * A missing archive must never be able to turn the proof into a silent no-op.
 */

const ARCHIVELESS_ENVIRONMENTS = new Set(["dev"]);

export function emitsUpdateArchive(buildEnvironment: string | undefined): boolean {
	return !(buildEnvironment !== undefined && ARCHIVELESS_ENVIRONMENTS.has(buildEnvironment));
}
