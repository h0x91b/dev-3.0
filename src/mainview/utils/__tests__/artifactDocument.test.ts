import { describe, expect, it } from "vitest";
import { composeArtifactDocument } from "../artifactDocument";

describe("composeArtifactDocument", () => {
	it("injects a restrictive CSP and rewrites copied relative image references", () => {
		const html = '<!doctype html><html><head></head><body><img src="chart.png"><div style="background:url(\'./diagram.webp\')"></div></body></html>';
		const output = composeArtifactDocument(html, [
			{ name: "chart.png", mime: "image/png", dataUrl: "data:image/png;base64,AAA" },
			{ name: "diagram.webp", mime: "image/webp", dataUrl: "data:image/webp;base64,BBB" },
		]);
		expect(output).toContain("Content-Security-Policy");
		expect(output).toContain("connect-src 'none'");
		expect(output).toContain('src="data:image/png;base64,AAA"');
		expect(output).toContain("url('data:image/webp;base64,BBB')");
	});

	it("leaves external URLs present so CSP blocks them rather than silently changing content", () => {
		const output = composeArtifactDocument('<html><head></head><body><img src="https://example.com/x.png"></body></html>', []);
		expect(output).toContain('src="https://example.com/x.png"');
	});
});
