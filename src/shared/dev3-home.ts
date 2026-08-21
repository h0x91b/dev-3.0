import { resolveUserHome } from "./user-home";

/**
 * The one place that decides where the dev-3.0 data root is.
 *
 * Lives in `shared/` because THREE processes must agree on the answer: the app,
 * the `dev3` CLI (which recomputes it independently — see `src/cli/context.ts`),
 * and the native terminal host. When they disagree, an instance is half-scoped:
 * that is the bug this function exists to make impossible.
 *
 * `$DEV3_HOME` is a REDIRECT, never a migration — an instance pointed elsewhere
 * simply writes elsewhere. Nothing under the real `~/.dev3.0` is renamed, moved
 * or deleted, so the frozen on-disk layout invariants (AGENTS.md) hold. See
 * `decisions/2026/08/21/scoped-qa-app-instance.md`.
 *
 * Beware the name: `DEV3_HOME` is both this environment variable and the derived
 * constant in `src/bun/paths.ts`. They agree only because that constant is built
 * from this function. `src/bun/__tests__/dev3-home-single-source.test.ts` fails if
 * a module starts composing the root itself again.
 *
 * Normalised to forward slashes for the same reason `resolveUserHome` is: the
 * result is concatenated into paths as a string, and a mixed-separator root would
 * break the prefix comparisons that decide whether a path is dev3-managed.
 */
export function resolveDev3Home(env: Record<string, string | undefined> = process.env): string {
	const override = env.DEV3_HOME?.trim();
	if (override) {
		const forward = override.replaceAll("\\", "/");
		return forward.length > 1 && forward.endsWith("/") ? forward.slice(0, -1) : forward;
	}
	return `${resolveUserHome(env)}/.dev3.0`;
}
