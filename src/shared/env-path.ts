/**
 * Reading the search PATH out of an environment block, whatever it is called.
 *
 * Windows spells the variable `Path`, and the OS treats environment names
 * case-insensitively — but a JS `process.env` object does not necessarily do the
 * same. On a real Windows run dev3 logged `SystemRoot` fine while
 * `process.env.PATH` was undefined, so every PATH consumer (Bun.which, binary
 * resolution, spawned children) saw an empty search path and reported git as
 * "not found" even though git was installed and on the user's Path.
 *
 * These helpers are pure and platform-independent: they look for the exact key
 * first (so POSIX is untouched and free) and only then fall back to a
 * case-insensitive scan.
 */

const PATH_KEY = "PATH";

type EnvLike = Record<string, string | undefined>;

/** The key that actually holds the search path, or `undefined` if there is none. */
export function findEnvPathKey(env: EnvLike): string | undefined {
	if (typeof env[PATH_KEY] === "string") return PATH_KEY;
	for (const key of Object.keys(env)) {
		if (key.toUpperCase() === PATH_KEY && typeof env[key] === "string") return key;
	}
	return undefined;
}

/** The search path value under whatever casing the platform used. */
export function readEnvPath(env: EnvLike): string | undefined {
	const key = findEnvPathKey(env);
	return key === undefined ? undefined : env[key];
}

export type PathNormalizationResult =
	| { outcome: "already-canonical" }
	| { outcome: "aliased"; fromKey: string; length: number }
	| { outcome: "missing"; envKeys: string[] };

/**
 * Make `env.PATH` readable under the canonical spelling.
 *
 * Mutates in place because the whole point is to fix the single `process.env`
 * that `Bun.which()` and every spawned child read. Returns what it did so the
 * caller can log it — a still-missing PATH is a real diagnostic, and the env key
 * NAMES (never values) are what identify the cause.
 */
export function normalizeEnvPath(env: EnvLike): PathNormalizationResult {
	const key = findEnvPathKey(env);
	if (key === PATH_KEY) return { outcome: "already-canonical" };
	if (key === undefined) return { outcome: "missing", envKeys: Object.keys(env).sort() };
	const value = env[key] as string;
	env[PATH_KEY] = value;
	return { outcome: "aliased", fromKey: key, length: value.length };
}
