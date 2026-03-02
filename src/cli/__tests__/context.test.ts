import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { detectContext } from "../context";

const TEST_DIR = "/tmp/dev3-cli-test-context";

beforeEach(() => {
	if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
	mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
	if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
});

describe("detectContext", () => {
	it("returns null when no marker found", () => {
		expect(detectContext(TEST_DIR)).toBeNull();
	});

	it("detects marker in cwd", () => {
		const marker = {
			projectId: "proj-123",
			taskId: "task-456",
			socketPath: "/tmp/test.sock",
		};
		writeFileSync(`${TEST_DIR}/.dev3-marker`, JSON.stringify(marker));

		const ctx = detectContext(TEST_DIR);
		expect(ctx).toEqual({
			projectId: "proj-123",
			taskId: "task-456",
			socketPath: "/tmp/test.sock",
		});
	});

	it("detects marker in parent directory", () => {
		const marker = {
			projectId: "proj-abc",
			taskId: "task-def",
			socketPath: "/tmp/parent.sock",
		};
		writeFileSync(`${TEST_DIR}/.dev3-marker`, JSON.stringify(marker));

		const nestedDir = `${TEST_DIR}/src/components`;
		mkdirSync(nestedDir, { recursive: true });

		const ctx = detectContext(nestedDir);
		expect(ctx).toEqual({
			projectId: "proj-abc",
			taskId: "task-def",
			socketPath: "/tmp/parent.sock",
		});
	});

	it("returns null for malformed marker JSON", () => {
		writeFileSync(`${TEST_DIR}/.dev3-marker`, "not json");
		expect(detectContext(TEST_DIR)).toBeNull();
	});
});
