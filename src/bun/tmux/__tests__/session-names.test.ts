import { describe, it, expect } from "vitest";
import {
	taskSessionName,
	projectTerminalSessionName,
	devServerSessionName,
	cleanupSessionName,
	devServerSessionForTaskSession,
	parseDev3SessionName,
	sessionShortId,
} from "../session-names";

const TASK_ID = "593e966a-abed-4971-8060-e34aea460fe6";

describe("session name builders", () => {
	it("embeds the first 8 chars of the id", () => {
		expect(sessionShortId(TASK_ID)).toBe("593e966a");
		expect(taskSessionName(TASK_ID)).toBe("dev3-593e966a");
		expect(projectTerminalSessionName(TASK_ID)).toBe("dev3-pt-593e966a");
		expect(devServerSessionName(TASK_ID)).toBe("dev3-dev-593e966a");
		expect(cleanupSessionName(TASK_ID)).toBe("dev3-cl-593e966a");
	});

	it("derives the dev-server sibling from a task session name", () => {
		expect(devServerSessionForTaskSession("dev3-593e966a")).toBe("dev3-dev-593e966a");
	});
});

describe("parseDev3SessionName", () => {
	it("round-trips every builder", () => {
		expect(parseDev3SessionName(taskSessionName(TASK_ID))).toEqual({ kind: "task", shortId: "593e966a" });
		expect(parseDev3SessionName(projectTerminalSessionName(TASK_ID))).toEqual({ kind: "project-terminal", shortId: "593e966a" });
		expect(parseDev3SessionName(devServerSessionName(TASK_ID))).toEqual({ kind: "dev-server", shortId: "593e966a" });
		expect(parseDev3SessionName(cleanupSessionName(TASK_ID))).toEqual({ kind: "cleanup", shortId: "593e966a" });
	});

	it("returns null for non-dev3 sessions", () => {
		expect(parseDev3SessionName("main")).toBeNull();
		expect(parseDev3SessionName("mydev3-abc")).toBeNull();
		expect(parseDev3SessionName("")).toBeNull();
	});

	it("returns null for a bare prefix with no id fragment", () => {
		expect(parseDev3SessionName("dev3-")).toBeNull();
		expect(parseDev3SessionName("dev3-pt-")).toBeNull();
		expect(parseDev3SessionName("dev3-dev-")).toBeNull();
		expect(parseDev3SessionName("dev3-cl-")).toBeNull();
	});

	it("parses legacy non-uuid names as task sessions (callers filter dev3-home)", () => {
		expect(parseDev3SessionName("dev3-home")).toEqual({ kind: "task", shortId: "home" });
	});
});
