/**
 * Compare two semver version strings (e.g. "0.2.9" vs "0.2.11").
 * Returns true if `remote` is strictly greater than `local`.
 */
export function isNewerVersion(local: string, remote: string): boolean {
	const parse = (v: string) => {
		const parts = v.replace(/^v/, "").split(".").map(Number);
		return { major: parts[0] || 0, minor: parts[1] || 0, patch: parts[2] || 0 };
	};
	const l = parse(local);
	const r = parse(remote);
	if (r.major !== l.major) return r.major > l.major;
	if (r.minor !== l.minor) return r.minor > l.minor;
	return r.patch > l.patch;
}
