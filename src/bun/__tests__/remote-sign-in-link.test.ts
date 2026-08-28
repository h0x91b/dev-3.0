/**
 * The bookmarkable sign-in link. The single reason the code rides the FRAGMENT
 * and not the query is that a fragment is never put on the wire — so the tests
 * that matter here are the ones pinning that the code never lands in the part of
 * the URL a server, a tunnel or a proxy gets to see.
 */
import { describe, it, expect } from "vitest";
import {
	buildSignInLink,
	readCodeFromFragment,
	stripCodeFromFragment,
	SIGN_IN_CODE_FRAGMENT_KEY,
} from "../../shared/remote-sign-in-link";

describe("buildSignInLink", () => {
	it("puts the code in the fragment, never in the query", () => {
		const link = buildSignInLink("https://x.trycloudflare.com/?token=one-time", "sesame-open-up");
		const url = new URL(link);
		expect(url.hash).toBe("#code=sesame-open-up");
		// Everything before the "#" is what actually travels to the server.
		expect(link.split("#")[0]).not.toContain("sesame-open-up");
		expect(url.search).toBe("?token=one-time");
	});

	it("percent-encodes a code that would otherwise break the fragment", () => {
		const link = buildSignInLink("http://192.168.0.1:1234/", "a b&c=d#e");
		expect(link.split("#")[0]).not.toContain("a b");
		expect(readCodeFromFragment(new URL(link).hash)).toBe("a b&c=d#e");
	});

	it("replaces an existing fragment instead of stacking a second one", () => {
		const link = buildSignInLink("http://host/#stale", "sesame");
		expect(link).toBe("http://host/#code=sesame");
		expect(link.split("#")).toHaveLength(2);
	});
});

describe("readCodeFromFragment", () => {
	it("reads the code with or without the leading hash", () => {
		expect(readCodeFromFragment("#code=sesame")).toBe("sesame");
		expect(readCodeFromFragment("code=sesame")).toBe("sesame");
	});

	it("survives a fragment carrying other keys", () => {
		expect(readCodeFromFragment("#view=board&code=sesame")).toBe("sesame");
	});

	// A malformed link must fall through to the sign-in screen, never throw
	// during boot — a thrown error there is a blank page with no way back.
	it.each([undefined, null, "", "#", "#code=", "#code=%20", "#other=1"])(
		"returns null for %p instead of throwing",
		(hash) => {
			expect(readCodeFromFragment(hash as string | null | undefined)).toBeNull();
		},
	);
});

describe("stripCodeFromFragment", () => {
	it("removes only the code and keeps the rest of the fragment", () => {
		expect(stripCodeFromFragment("#view=board&code=sesame")).toBe("view=board");
	});

	it("empties a fragment that carried nothing else", () => {
		expect(stripCodeFromFragment("#code=sesame")).toBe("");
	});

	it("leaves a fragment without a code untouched", () => {
		expect(stripCodeFromFragment("#view=board")).toBe("view=board");
		expect(stripCodeFromFragment("")).toBe("");
	});

	it("round-trips: what it strips is exactly what readCodeFromFragment found", () => {
		const link = buildSignInLink("http://host/?a=1", "sesame");
		const hash = new URL(link).hash;
		expect(readCodeFromFragment(hash)).toBe("sesame");
		expect(stripCodeFromFragment(hash)).not.toContain("sesame");
		expect(stripCodeFromFragment(hash)).not.toContain(SIGN_IN_CODE_FRAGMENT_KEY);
	});
});
