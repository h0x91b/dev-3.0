import { homedir, tmpdir, userInfo } from "node:os";

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
 *
 * Lives in `shared/` because the CLI resolves the same home independently of the
 * app process, and the two must agree on where `~/.dev3.0` is.
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

/**
 * The home directory of the account the process runs as, from the account database.
 * Unlike `resolveUserHome` it ignores `$HOME`: a launcher may point that at a private
 * directory, while the machine-wide `~/.dev3.0/bin/dev3` lives in the account's own.
 * Falls back to `resolveUserHome` when the platform has no account entry.
 */
export function resolveAccountHome(account: () => string = () => userInfo().homedir): string {
	try {
		const home = account()?.trim();
		if (home) return normalizeHome(home);
	} catch {
		// no account database entry
	}
	return resolveUserHome();
}

function normalizeHome(home: string): string {
	const forward = home.replaceAll("\\", "/");
	// Keep a trailing-slash-free root so `${DEV3_HOME}` never doubles a separator.
	return forward.length > 1 && forward.endsWith("/") ? forward.slice(0, -1) : forward;
}
