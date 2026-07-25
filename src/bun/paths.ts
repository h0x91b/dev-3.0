import { homedir, tmpdir } from "node:os";

/**
 * The user's home directory, as dev3 spells it.
 *
 * `$HOME` stays first so POSIX behaviour — and every test that points dev3 at a
 * temp dir by setting it — is unchanged. Windows does not define `$HOME`, so the
 * old `"/tmp"` fallback silently sent the whole data root to `C:\tmp\.dev3.0`;
 * `%USERPROFILE%` / `os.homedir()` are the real answer there.
 *
 * The result is normalised to forward slashes because `DEV3_HOME` is composed
 * into paths by string concatenation across the codebase (`${DEV3_HOME}/logs`),
 * and Windows file APIs accept `/`. Mixing separators inside one string would
 * break the prefix comparisons that decide whether a path is dev3-managed.
 */
export function resolveUserHome(
	env: Record<string, string | undefined> = process.env,
	os: { homedir: () => string; tmpdir: () => string } = { homedir, tmpdir },
): string {
	const candidates = [env.HOME, env.USERPROFILE];
	for (const candidate of candidates) {
		const trimmed = candidate?.trim();
		if (trimmed) return normalizeHome(trimmed);
	}
	try {
		const resolved = os.homedir()?.trim();
		if (resolved) return normalizeHome(resolved);
	} catch {
		// homedir() throws when the platform cannot answer; fall through to tmpdir.
	}
	return normalizeHome(os.tmpdir());
}

function normalizeHome(home: string): string {
	const forward = home.replaceAll("\\", "/");
	// Keep a trailing-slash-free root so `${DEV3_HOME}` never doubles a separator.
	return forward.length > 1 && forward.endsWith("/") ? forward.slice(0, -1) : forward;
}

const HOME = resolveUserHome();

/** Root directory for all dev-3.0 data: projects, tasks, worktrees, logs */
export const DEV3_HOME = `${HOME}/.dev3.0`;

/**
 * Root for virtual ("Operations") boards. A virtual project's synthetic `path`
 * is `${OPS_DIR}/<readable-slug>`; its managed task working dirs nest under it
 * at `${OPS_DIR}/<readable-slug>/<taskId>/work`. This is an additive tree —
 * older app versions never read it, preserving the on-disk layout invariants.
 */
export const OPS_DIR = `${DEV3_HOME}/ops`;
