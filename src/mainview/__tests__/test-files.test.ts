import { describe, it, expect } from "vitest";
import { isTestFile } from "../../shared/test-files";

describe("isTestFile", () => {
	it("flags files in __tests__ folders", () => {
		expect(isTestFile("src/foo/__tests__/bar.ts")).toBe(true);
		expect(isTestFile("__tests__/utils.test.tsx")).toBe(true);
	});

	it("flags files in __mocks__ folders", () => {
		expect(isTestFile("src/api/__mocks__/client.ts")).toBe(true);
	});

	it("flags files in test/tests/e2e/spec directories", () => {
		expect(isTestFile("test/integration/login.ts")).toBe(true);
		expect(isTestFile("tests/setup.js")).toBe(true);
		expect(isTestFile("e2e/login.spec.ts")).toBe(true);
		expect(isTestFile("spec/api/users.rb")).toBe(true);
	});

	it("flags JS/TS test files by suffix", () => {
		expect(isTestFile("src/utils.test.ts")).toBe(true);
		expect(isTestFile("src/utils.spec.tsx")).toBe(true);
		expect(isTestFile("src/utils.test.bun.ts")).toBe(true);
		expect(isTestFile("src/utils.spec.mjs")).toBe(true);
		expect(isTestFile("src/utils.test.cts")).toBe(true);
	});

	it("flags Go/Python/Ruby test files", () => {
		expect(isTestFile("pkg/foo_test.go")).toBe(true);
		expect(isTestFile("app/test_models.py")).toBe(true);
		expect(isTestFile("app/foo_test.py")).toBe(true);
		expect(isTestFile("spec/models/user_spec.rb")).toBe(true);
	});

	it("does not flag production code", () => {
		expect(isTestFile("src/components/Button.tsx")).toBe(false);
		expect(isTestFile("src/utils/format.ts")).toBe(false);
		expect(isTestFile("backend/app/main.py")).toBe(false);
		expect(isTestFile("README.md")).toBe(false);
		expect(isTestFile("src/testing.ts")).toBe(false); // "testing" is not "test"
		expect(isTestFile("src/atest.ts")).toBe(false);
	});

	it("handles empty/invalid input", () => {
		expect(isTestFile("")).toBe(false);
	});

	it("normalises backslash-separated paths", () => {
		expect(isTestFile("src\\__tests__\\foo.ts")).toBe(true);
		expect(isTestFile("src\\utils.test.ts")).toBe(true);
	});
});
