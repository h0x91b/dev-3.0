import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addAgyPending, agyPendingSessionsOf, forgetAgyTask, removeAgyPending } from "../agy-session-state";

let home: string;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "dev3-agy-session-state-"));
});

afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

describe("agy pending waits", () => {
	it("counts the sessions of a task that wait, and reports how many remain", () => {
		addAgyPending("t1", "a");
		addAgyPending("t1", "b");
		expect(removeAgyPending("t1", "a")).toBe(1);
		expect([...agyPendingSessionsOf("t1")]).toEqual(["b"]);
		expect(removeAgyPending("t1", "b")).toBe(0);
		expect(agyPendingSessionsOf("t1").size).toBe(0);
	});
});

describe("forgetAgyTask", () => {
	it("drops the task's waits and its per-pane statusLine state, and only that task's", () => {
		const mine = join(home, "data", "agy-statusline", "t1");
		const other = join(home, "data", "agy-statusline", "t2");
		mkdirSync(mine, { recursive: true });
		mkdirSync(other, { recursive: true });
		writeFileSync(join(mine, "p_1.json"), "{}");
		writeFileSync(join(other, "p_1.json"), "{}");
		addAgyPending("t1", "a");

		forgetAgyTask("t1", home);

		expect(existsSync(mine)).toBe(false);
		expect(existsSync(join(other, "p_1.json"))).toBe(true);
		expect(agyPendingSessionsOf("t1").size).toBe(0);
	});

	it("never follows a task id that is not a plain path segment", () => {
		const outside = join(home, "data", "keep");
		mkdirSync(outside, { recursive: true });
		forgetAgyTask("../keep", home);
		expect(existsSync(outside)).toBe(true);
	});
});
