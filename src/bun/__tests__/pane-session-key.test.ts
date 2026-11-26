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
		// A real dev3-task-<uuid> composite round-trips too.
		const taskId = "dev3-task-00000000-0000-4000-8000-000000000001";
		expect(parsePaneSessionKey(paneSessionKey(taskId, "pane-2"))).toEqual({ taskId, paneId: "pane-2" });
	});

	it("the separator must stay URL-safe: a key needs no escaping in ?session=", () => {
		const key = paneSessionKey("task-abc", "pane-3");
		// RFC 3986 §2.3 unreserved chars: A-Z a-z 0-9 - . _ ~
		const urlSafe = /^[A-Za-z0-9\-._~]+$/.test(key);
		expect(urlSafe).toBe(true);
	});

	it("returns null for a bare task id (the first pane's key), an empty string, and a leading separator", () => {
		expect(parsePaneSessionKey("task-abc"), "bare").toBeNull();
		expect(parsePaneSessionKey(""), "empty").toBeNull();
		expect(parsePaneSessionKey("~pane-1"), "leading separator").toBeNull();
	});
});
