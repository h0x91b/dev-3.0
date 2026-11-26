import { readFileSync } from "node:fs";
import { join } from "node:path";
import { guardSharedRealm } from "../../../test-realm-guard";

describe("guardSharedRealm", () => {
	it("undoes prototype, global, console and storage patches made after the snapshot", () => {
		const originalRect = Element.prototype.getBoundingClientRect;
		const originalError = console.error;
		const restore = guardSharedRealm();

		Element.prototype.getBoundingClientRect = () => new DOMRect(1, 2, 3, 4);
		Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: () => {} });
		(HTMLElement.prototype as unknown as Record<string, unknown>).leakedByATest = 1;
		(globalThis as Record<string, unknown>).leakedGlobal = 1;
		console.error = () => {};
		localStorage.setItem("leaked", "1");
		process.env.DEV3_TEST_LEAKED = "1";
		const home = process.env.HOME;
		delete process.env.HOME;

		restore();

		expect(Element.prototype.getBoundingClientRect).toBe(originalRect);
		expect(Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView")?.writable).not.toBe(false);
		expect("leakedByATest" in HTMLElement.prototype).toBe(false);
		expect("leakedGlobal" in globalThis).toBe(false);
		expect(console.error).toBe(originalError);
		expect(localStorage.getItem("leaked")).toBeNull();
		expect(process.env.DEV3_TEST_LEAKED).toBeUndefined();
		expect(process.env.HOME).toBe(home);
	});

	it("cancels the timers a file left pending, as the end of a fork used to", async () => {
		const restore = guardSharedRealm();
		const fired = vi.fn();
		setTimeout(fired, 5);
		const interval = setInterval(fired, 5);
		restore();
		await new Promise((resolve) => setTimeout(resolve, 30));
		clearInterval(interval);
		expect(fired).not.toHaveBeenCalled();
	});

	it("is the first afterAll the renderer setup registers, and the renderer runs on vmThreads", () => {
		const setup = readFileSync(join(process.cwd(), "src/mainview/test-setup.ts"), "utf8");
		const firstHook = /\b(afterAll|afterEach|beforeEach|beforeAll)\(/.exec(setup);
		expect(firstHook?.[0]).toBe("afterAll(");
		expect(setup.slice(firstHook!.index, firstHook!.index + 40)).toContain("guardSharedRealm()");
		const config = readFileSync(join(process.cwd(), "vitest.config.ts"), "utf8");
		expect(config).toMatch(/pool: "vmThreads"/);
	});

	it("also guards the backend suite, which runs on vmForks", () => {
		const setup = readFileSync(join(process.cwd(), "src/bun/test-setup.ts"), "utf8");
		expect(setup).toContain("afterAll(guardSharedRealm());");
		const config = readFileSync(join(process.cwd(), "vitest.config.bun.ts"), "utf8");
		expect(config).toMatch(/pool: "vmForks"/);
	});
});
