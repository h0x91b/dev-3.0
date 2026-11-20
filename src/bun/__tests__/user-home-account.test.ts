import { afterEach, describe, expect, it } from "vitest";
import { userInfo } from "node:os";
import { resolveAccountHome } from "../../shared/user-home";

const originalHome = process.env.HOME;

afterEach(() => {
	if (originalHome === undefined) delete process.env.HOME;
	else process.env.HOME = originalHome;
});

describe("resolveAccountHome", () => {
	it("answers the account database's home and ignores $HOME, which a launcher overrides", () => {
		process.env.HOME = "/launcher/private/home";
		expect(resolveAccountHome()).toBe(userInfo().homedir.replaceAll("\\", "/"));
	});

	it("normalizes the answer: forward slashes, no trailing slash", () => {
		expect(resolveAccountHome(() => "C:\\Users\\me\\")).toBe("C:/Users/me");
		expect(resolveAccountHome(() => "/home/me/")).toBe("/home/me");
	});

	it("falls back to the $HOME-based home when the platform has no account entry", () => {
		process.env.HOME = "/fallback/home";
		expect(resolveAccountHome(() => { throw new Error("no entry"); })).toBe("/fallback/home");
		expect(resolveAccountHome(() => "  ")).toBe("/fallback/home");
	});
});
