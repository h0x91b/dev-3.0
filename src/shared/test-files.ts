// Heuristic to classify a file path as a test file across many languages
// and frameworks. Used by the diff viewer and task top-bar badge to
// optionally filter tests so the user can review production code only.
export function isTestFile(path: string): boolean {
	if (!path) return false;
	const normalized = path.replace(/\\/g, "/");
	const lower = normalized.toLowerCase();
	const segments = lower.split("/");
	const fileName = segments[segments.length - 1] ?? "";
	const originalSegments = normalized.split("/");
	const originalFileName = originalSegments[originalSegments.length - 1] ?? "";

	for (const segment of segments) {
		if (segment === "__tests__" || segment === "__mocks__") return true;
		if (segment === "__snapshots__" || segment === "__fixtures__") return true;
		if (segment === "tests" || segment === "test") return true;
		if (segment === "spec" || segment === "specs") return true;
		if (segment === "e2e" || segment === "cypress" || segment === "playwright") return true;
		if (segment === "testdata" || segment === "fixtures" || segment === "fixture") return true;
		if (segment === "integration-tests" || segment === "unit-tests" || segment === "e2e-tests") return true;
	}

	// JS/TS family — *.test.ts / *.spec.tsx / *.e2e.ts / *.cy.tsx / *.bench.ts ...
	if (/\.(test|spec|e2e|e2e-spec|cy|bench|benchmark)\.[cm]?[jt]sx?$/.test(fileName)) return true;
	// JS/TS with framework qualifier — *.test.bun.ts, *.test.node.ts ...
	if (/\.(test|spec)\.(bun|node|browser|jsdom)\.[cm]?[jt]sx?$/.test(fileName)) return true;

	// Python — test_foo.py, foo_test.py, conftest.py, tests.py
	if (/^test_.+\.py$/.test(fileName)) return true;
	if (/_test\.py$/.test(fileName)) return true;
	if (fileName === "conftest.py" || fileName === "tests.py") return true;

	// Go — *_test.go
	if (/_test\.go$/.test(fileName)) return true;

	// Rust — *_test.rs
	if (/_test\.rs$/.test(fileName)) return true;

	// Ruby — *_spec.rb, *_test.rb
	if (/_spec\.rb$/.test(fileName)) return true;
	if (/_test\.rb$/.test(fileName)) return true;

	// Elixir — foo_test.exs
	if (/_test\.exs$/.test(fileName)) return true;

	// Dart / Flutter — foo_test.dart
	if (/_test\.dart$/.test(fileName)) return true;

	// PascalCase-suffix conventions (Java / Kotlin / Scala / C# / PHP / Swift)
	// Match files ending with "Test", "Tests", "Spec", "IT", "Fact", "Facts"
	// where the suffix is preceded by a lowercase letter (so "FooTest.java"
	// matches but "latest.java" does not — "latest" ends in "test" lowercase).
	if (/[a-z](Test|Tests|Spec|Specs|IT|ITCase|Fact|Facts)\.(java|kt|kts|groovy|scala|cs|fs|vb|php|swift|m|mm)$/.test(originalFileName)) return true;
	// Some projects use lower-case `Test` suffix even in non-JS languages — guard
	// against "latest"/"digest" by also requiring an explicit camelCase boundary
	// captured above; nothing extra to add here.

	// Storybook stories (treated as test-adjacent — visual fixtures)
	if (/\.stories\.([cm]?[jt]sx?|mdx)$/.test(fileName)) return true;

	return false;
}
