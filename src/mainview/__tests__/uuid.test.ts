import { afterEach, describe, expect, it } from "vitest";
import { installRandomUUID, randomUUID } from "../uuid";

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** What a browser does on a plain-http LAN address: the method is simply not there. */
function withholdRandomUUID(): void {
	Object.defineProperty(crypto, "randomUUID", { value: undefined, configurable: true, writable: true });
}

afterEach(() => {
	// Drop the own property so the platform's method shows through again.
	delete (crypto as { randomUUID?: unknown }).randomUUID;
});

describe("randomUUID", () => {
	it("returns a v4 id where the platform provides one", () => {
		expect(randomUUID()).toMatch(V4);
	});

	it("still returns distinct v4 ids outside a secure context", () => {
		withholdRandomUUID();
		const ids = new Set(Array.from({ length: 50 }, () => randomUUID()));
		expect(ids.size).toBe(50);
		for (const id of ids) expect(id).toMatch(V4);
	});
});

describe("installRandomUUID", () => {
	it("makes a direct crypto.randomUUID() call work outside a secure context", () => {
		withholdRandomUUID();
		expect(typeof crypto.randomUUID).toBe("undefined");

		installRandomUUID();

		expect(crypto.randomUUID()).toMatch(V4);
		// The helper now routes through the installed one; it must not call itself forever.
		expect(randomUUID()).toMatch(V4);
	});

	it("leaves the platform's own implementation alone", () => {
		const native = crypto.randomUUID;
		installRandomUUID();
		expect(crypto.randomUUID).toBe(native);
	});
});
