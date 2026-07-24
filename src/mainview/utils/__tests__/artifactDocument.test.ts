import { describe, expect, it } from "vitest";
import { composeArtifactDocument } from "../artifactDocument";

describe("composeArtifactDocument", () => {
	it("injects the network-open CSP and rewrites copied relative image references", () => {
		const html = '<!doctype html><html><head></head><body><img src="chart.png"><div style="background:url(\'./diagram.webp\')"></div></body></html>';
		const output = composeArtifactDocument(html, [
			{ name: "chart.png", mime: "image/png", dataUrl: "data:image/png;base64,AAA" },
			{ name: "diagram.webp", mime: "image/webp", dataUrl: "data:image/webp;base64,BBB" },
		]);
		expect(output).toContain("Content-Security-Policy");
		// Artifacts may load libraries from any origin and reach any server —
		// the iframe sandbox, not the CSP, is the isolation boundary (decision 163).
		expect(output).toContain("script-src 'unsafe-inline' data: blob: https: http:");
		expect(output).toContain("connect-src data: blob: https: http: ws: wss:");
		expect(output).toContain("object-src 'none'");
		expect(output).toContain('src="data:image/png;base64,AAA"');
		expect(output).toContain("url('data:image/webp;base64,BBB')");
	});

	it("rewrites nested relative image paths without flattening them", () => {
		const output = composeArtifactDocument('<img src="assets/charts/q1.png">', [
			{ name: "assets/charts/q1.png", mime: "image/png", dataUrl: "data:image/png;base64,NESTED" },
		]);
		expect(output).toContain('src="data:image/png;base64,NESTED"');
	});

	it("leaves external URLs untouched — only copied relative assets are rewritten", () => {
		const output = composeArtifactDocument('<html><head></head><body><img src="https://example.com/x.png"></body></html>', []);
		expect(output).toContain('src="https://example.com/x.png"');
	});

	it("injects the save-image context menu with the localized label when provided", () => {
		const output = composeArtifactDocument('<html><head></head><body><img src="chart.png"></body></html>', [], "Save image");
		expect(output).toContain("data-dev3-artifact-menu");
		expect(output).toContain("dev3-artifact-save-image");
		expect(output).toContain('"Save image"');
	});

	it("omits the save-image menu when no label is provided", () => {
		const output = composeArtifactDocument('<html><head></head><body><img src="chart.png"></body></html>', []);
		expect(output).not.toContain("data-dev3-artifact-menu");
	});
});
