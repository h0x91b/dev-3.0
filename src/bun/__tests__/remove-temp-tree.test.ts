import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { removeTempTree } from "./helpers/remove-temp-tree";

const errno = (code: string) => Object.assign(new Error(`${code}: resource busy or locked, rm 'x'`), { code });

describe("removeTempTree", () => {
	it("deletes a real tree", () => {
		const root = mkdtempSync(join(tmpdir(), "dev3-remove-temp-tree-"));
		mkdirSync(join(root, "a", "b"), { recursive: true });
		writeFileSync(join(root, "a", "b", "f.txt"), "x");
		removeTempTree(root);
		expect(existsSync(root)).toBe(false);
	});

	it("rides out a lock Windows releases a moment later", () => {
		let calls = 0;
		const slept: number[] = [];
		removeTempTree("x", {
			rm: () => {
				calls += 1;
				if (calls < 3) throw errno("EBUSY");
			},
			sleep: (ms) => void slept.push(ms),
		});
		expect(calls).toBe(3);
		expect(slept).toEqual([250, 250]);
	});

	it("still throws when the lock outlasts the budget, so a leaked process surfaces", () => {
		let calls = 0;
		expect(() =>
			removeTempTree("x", {
				attempts: 4,
				rm: () => {
					calls += 1;
					throw errno("EBUSY");
				},
				sleep: () => {},
			}),
		).toThrow(/EBUSY/);
		expect(calls).toBe(4);
	});

	it("never retries a non-transient error", () => {
		let calls = 0;
		expect(() =>
			removeTempTree("x", {
				rm: () => {
					calls += 1;
					throw errno("ENAMETOOLONG");
				},
				sleep: () => {},
			}),
		).toThrow(/ENAMETOOLONG/);
		expect(calls).toBe(1);
	});
});
