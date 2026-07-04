import { describe, it, expect } from "vitest";
import { ansiToHtml } from "../ansi-to-html";

const ESC = "\x1b";

describe("ansiToHtml — semicolon SGR", () => {
	it("passes plain text through unchanged", () => {
		expect(ansiToHtml("hello")).toBe("hello");
	});

	it("escapes HTML metacharacters", () => {
		expect(ansiToHtml("<a> & </a>")).toBe("&lt;a&gt; &amp; &lt;/a&gt;");
	});

	it("renders a 256-color foreground", () => {
		const html = ansiToHtml(`${ESC}[38;5;196mRED${ESC}[0m`);
		expect(html).toContain("RED");
		expect(html).toContain("color:");
		expect(html).not.toContain(ESC);
	});

	it("renders a 24-bit true-color foreground", () => {
		const html = ansiToHtml(`${ESC}[38;2;255;0;0mTRUE${ESC}[0m`);
		expect(html).toContain("rgb(255,0,0)");
		expect(html).toContain("TRUE");
	});
});

describe("ansiToHtml — colon-form SGR (ITU / kitty style)", () => {
	it("consumes a colon-form 256-color sequence and keeps the text", () => {
		const html = ansiToHtml(`${ESC}[38:5:196mRED${ESC}[0m`);
		expect(html).toContain("RED");
		// The escape must be fully consumed, never leaked as visible text.
		expect(html).not.toContain(ESC);
		expect(html).not.toContain("38:5:196");
		expect(html).not.toContain("[38");
		// Best-effort: the color is actually applied, same as the semicolon form.
		expect(html).toContain(ansiToHtml(`${ESC}[38;5;196mX`).match(/color:[^;"]*/)?.[0]);
	});

	it("consumes a colon-form true-color sequence (with empty colorspace slot)", () => {
		const html = ansiToHtml(`${ESC}[38:2::255:0:0mTRUE${ESC}[0m`);
		expect(html).toContain("TRUE");
		expect(html).not.toContain(ESC);
		expect(html).toContain("rgb(255,0,0)");
	});

	it("consumes a colon-form underline-style sequence without leaking text", () => {
		const html = ansiToHtml(`${ESC}[4:3mUNDER${ESC}[0m`);
		expect(html).toContain("UNDER");
		expect(html).not.toContain(ESC);
		expect(html).not.toContain("4:3");
	});
});
