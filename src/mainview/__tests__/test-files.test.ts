import { describe, it, expect } from "vitest";
import { isTestFile } from "../../shared/test-files";

describe("isTestFile", () => {
	it("flags files in __tests__ / __mocks__ / __snapshots__ / __fixtures__ folders", () => {
		expect(isTestFile("src/foo/__tests__/bar.ts")).toBe(true);
		expect(isTestFile("__tests__/utils.test.tsx")).toBe(true);
		expect(isTestFile("src/api/__mocks__/client.ts")).toBe(true);
		expect(isTestFile("src/api/__snapshots__/a.snap")).toBe(true);
		expect(isTestFile("src/api/__fixtures__/data.json")).toBe(true);
	});

	it("flags files in test/tests/spec/specs/e2e/cypress/playwright directories", () => {
		expect(isTestFile("test/integration/login.ts")).toBe(true);
		expect(isTestFile("tests/setup.js")).toBe(true);
		expect(isTestFile("spec/api/users.rb")).toBe(true);
		expect(isTestFile("specs/foo.js")).toBe(true);
		expect(isTestFile("e2e/login.spec.ts")).toBe(true);
		expect(isTestFile("cypress/integration/login.js")).toBe(true);
		expect(isTestFile("playwright/login.test.ts")).toBe(true);
		expect(isTestFile("testdata/users.json")).toBe(true);
		expect(isTestFile("fixtures/users.json")).toBe(true);
		expect(isTestFile("integration-tests/foo.ts")).toBe(true);
	});

	it("flags JS/TS test files by suffix", () => {
		expect(isTestFile("src/utils.test.ts")).toBe(true);
		expect(isTestFile("src/utils.spec.tsx")).toBe(true);
		expect(isTestFile("src/utils.test.bun.ts")).toBe(true);
		expect(isTestFile("src/utils.spec.mjs")).toBe(true);
		expect(isTestFile("src/utils.test.cts")).toBe(true);
		expect(isTestFile("src/login.e2e.ts")).toBe(true);
		expect(isTestFile("src/login.e2e-spec.ts")).toBe(true);
		expect(isTestFile("src/login.cy.tsx")).toBe(true);
		expect(isTestFile("src/perf.bench.ts")).toBe(true);
		expect(isTestFile("src/perf.benchmark.ts")).toBe(true);
	});

	it("flags Python test files", () => {
		expect(isTestFile("app/test_models.py")).toBe(true);
		expect(isTestFile("app/foo_test.py")).toBe(true);
		expect(isTestFile("app/conftest.py")).toBe(true);
		expect(isTestFile("app/tests.py")).toBe(true);
	});

	it("flags Go/Rust test files", () => {
		expect(isTestFile("pkg/foo_test.go")).toBe(true);
		expect(isTestFile("src/utils_test.rs")).toBe(true);
	});

	it("flags Ruby test/spec files", () => {
		expect(isTestFile("spec/models/user_spec.rb")).toBe(true);
		expect(isTestFile("test/models/user_test.rb")).toBe(true);
	});

	it("flags Java/Kotlin/Scala/Groovy test files with PascalCase suffix", () => {
		expect(isTestFile("src/main/java/com/foo/BarTest.java")).toBe(true);
		expect(isTestFile("src/main/java/com/foo/BarTests.java")).toBe(true);
		expect(isTestFile("src/main/kotlin/Foo BarSpec.kt".replace(/ /g, ""))).toBe(true);
		expect(isTestFile("src/main/kotlin/FooSpec.kt")).toBe(true);
		expect(isTestFile("src/main/java/FooIT.java")).toBe(true);
		expect(isTestFile("scala/FooSpec.scala")).toBe(true);
	});

	it("flags C#/.NET test files", () => {
		expect(isTestFile("Project/Models/FooTest.cs")).toBe(true);
		expect(isTestFile("Project/Models/FooTests.cs")).toBe(true);
		expect(isTestFile("Project/MyFacts.cs")).toBe(true);
	});

	it("flags PHP/Swift test files with PascalCase suffix", () => {
		expect(isTestFile("tests/Unit/FooTest.php")).toBe(true);
		expect(isTestFile("ProjectTests/FooTests.swift")).toBe(true);
		expect(isTestFile("ProjectTests/FooTest.m")).toBe(true);
	});

	it("flags Elixir/Dart test files", () => {
		expect(isTestFile("test/foo_test.exs")).toBe(true);
		expect(isTestFile("test/foo_test.dart")).toBe(true);
	});

	it("flags Storybook stories", () => {
		expect(isTestFile("src/components/Button.stories.tsx")).toBe(true);
		expect(isTestFile("src/components/Button.stories.mdx")).toBe(true);
	});

	it("does not false-positive on production code", () => {
		expect(isTestFile("src/components/Button.tsx")).toBe(false);
		expect(isTestFile("src/utils/format.ts")).toBe(false);
		expect(isTestFile("backend/app/main.py")).toBe(false);
		expect(isTestFile("README.md")).toBe(false);
		expect(isTestFile("src/testing.ts")).toBe(false); // "testing" is not "test"
		expect(isTestFile("src/atest.ts")).toBe(false);
		expect(isTestFile("com/foo/latest.java")).toBe(false); // "latest" lowercase, not PascalCase
		expect(isTestFile("com/foo/digest.cs")).toBe(false);
		expect(isTestFile("src/contest.swift")).toBe(false);
	});

	it("handles empty/invalid input", () => {
		expect(isTestFile("")).toBe(false);
	});

	it("normalises backslash-separated paths", () => {
		expect(isTestFile("src\\__tests__\\foo.ts")).toBe(true);
		expect(isTestFile("src\\utils.test.ts")).toBe(true);
	});
});
