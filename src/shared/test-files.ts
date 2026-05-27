// Heuristic to classify a file path as a test file.
// Used by the diff viewer and task top-bar badge to optionally filter
// out tests so the user can see what changed in production code only.
export function isTestFile(path: string): boolean {
	if (!path) return false;
	const normalized = path.replace(/\\/g, "/").toLowerCase();
	const segments = normalized.split("/");
	const fileName = segments[segments.length - 1] ?? "";

	for (const segment of segments) {
		if (segment === "__tests__" || segment === "__mocks__") return true;
		if (segment === "tests" || segment === "test") return true;
		if (segment === "e2e" || segment === "spec") return true;
	}

	if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(fileName)) return true;
	if (/\.(test|spec)\.(bun|node)\.[cm]?[jt]sx?$/.test(fileName)) return true;
	if (/_test\.(go|py|rb)$/.test(fileName)) return true;
	if (/_spec\.rb$/.test(fileName)) return true;
	if (/test_.+\.py$/.test(fileName)) return true;

	return false;
}
