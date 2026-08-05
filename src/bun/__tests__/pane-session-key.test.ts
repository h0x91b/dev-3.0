/**
 * Pane session key round-trip and URL safety (seq 1311).
 *
 * The URL-safety case is the only guard on the SEPARATOR: pty-server tests build
 * their keys with paneSessionKey() too, so they stay green if it changes.
 */
import { describe, expect, it } from "vitest";
import { paneSessionKey, parsePaneSessionKey } from "../../shared/pane-session-key";

describe("pane-session-key", () => {
	it("round-trips taskId + paneId through encode and parse", () => {
		const key = paneSessionKey("task-abc", "pane-3");
		const parsed = parsePaneSessionKey(key);
		expect(parsed).toEqual({ taskId: "task-abc", paneId: "pane-3" });
	});

	it("the separator must stay URL-safe: a key needs no escaping in ?session=", () => {
		const key = paneSessionKey("task-abc", "pane-3");
		// RFC 3986 §2.3 unreserved chars: A-Z a-z 0-9 - . _ ~
		const urlSafe = /^[A-Za-z0-9\-._~]+$/.test(key);
		expect(urlSafe).toBe(true);
	});

	it("the separator ~ does not appear in task UUIDs or pane ids", () => {
		const uuid = "00000000-0000-4000-8000-000000000001";
		const paneId = "pane-12";
		expect(uuid).not.toContain("~");
		expect(paneId).not.toContain("~");
	});

	it("returns null for a bare task id (first pane uses bare taskId)", () => {
		expect(parsePaneSessionKey("task-abc")).toBeNull();
	});

	it("returns null for an empty string", () => {
		expect(parsePaneSessionKey("")).toBeNull();
	});

	it("returns null for a key that starts with the separator", () => {
		expect(parsePaneSessionKey("~pane-1")).toBeNull();
	});

	it("handles a composite key built from a real dev3-task-<uuid>", () => {
		const taskId = "dev3-task-00000000-0000-4000-8000-000000000001";
		const paneId = "pane-2";
		const key = paneSessionKey(taskId, paneId);
		const parsed = parsePaneSessionKey(key);
		expect(parsed).toEqual({ taskId, paneId });
	});
});
