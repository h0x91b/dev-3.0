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
		// The iframe sandbox, not CSP, is the artifact security boundary.
		expect(output).toContain("default-src * data: blob: file: views: 'unsafe-inline' 'unsafe-eval'");
		expect(output).toContain("connect-src * data: blob: file: views: ws: wss:");
		expect(output).toContain('src="data:image/png;base64,AAA"');
		expect(output).toContain("url('data:image/webp;base64,BBB')");
	});

	it("keeps the sandbox CSP permissive for desktop schemes and artifact runtimes", () => {
		const output = composeArtifactDocument("<!doctype html><p>Artifact</p>", []);

		expect(output).toContain("default-src * data: blob: file: views: 'unsafe-inline' 'unsafe-eval'");
		expect(output).toContain("connect-src * data: blob: file: views: ws: wss:");
		expect(output).not.toContain("object-src 'none'");
		expect(output).not.toContain("base-uri 'none'");
	});

	it("rewrites nested relative image paths without flattening them", () => {
		const output = composeArtifactDocument('<img src="assets/charts/q1.png">', [
			{ name: "assets/charts/q1.png", mime: "image/png", dataUrl: "data:image/png;base64,NESTED" },
		]);
		expect(output).toContain('src="data:image/png;base64,NESTED"');
	});

	it("rewrites local stylesheets and classic scripts for the srcdoc sandbox", () => {
		const output = composeArtifactDocument(
			'<html><head><link rel="stylesheet" href="./app.css"></head><body><a href="app.css">Source</a><script defer src="app.js"></script></body></html>',
			[
				{ name: "app.css", mime: "text/css", dataUrl: "data:text/css;base64,Q1NT" },
				{ name: "app.js", mime: "text/javascript", dataUrl: "data:text/javascript;base64,SlM=" },
			],
		);

		expect(output).toContain('rel="stylesheet" href="data:text/css;base64,Q1NT"');
		expect(output).toContain('defer src="data:text/javascript;base64,SlM="');
		expect(output).toContain('<a href="app.css">Source</a>');
	});

	it("canonicalizes dot segments in quoted local asset paths", () => {
		const output = composeArtifactDocument(
			'<html><head><link rel="stylesheet" href="./nested/../app.css"></head><body><script src="./nested/../app.js"></script></body></html>',
			[
				{ name: "app.css", mime: "text/css", dataUrl: "data:text/css;charset=utf-8;base64,Q1NT" },
				{ name: "app.js", mime: "text/javascript", dataUrl: "data:text/javascript;charset=utf-8;base64,SlM=" },
			],
		);

		expect(output).toContain('href="data:text/css;charset=utf-8;base64,Q1NT"');
		expect(output).toContain('src="data:text/javascript;charset=utf-8;base64,SlM="');
		expect(output).not.toContain("./nested/../");
	});

	it("rewrites unquoted local asset attributes and quotes the resulting data URLs", () => {
		const output = composeArtifactDocument(
			'<html><head><link rel=stylesheet href=app.css></head><body><script src=app.js></script><img src=chart.png></body></html>',
			[
				{ name: "app.css", mime: "text/css", dataUrl: "data:text/css;charset=utf-8;base64,Q1NT" },
				{ name: "app.js", mime: "text/javascript", dataUrl: "data:text/javascript;charset=utf-8;base64,SlM=" },
				{ name: "chart.png", mime: "image/png", dataUrl: "data:image/png;base64,UE5H" },
			],
		);

		expect(output).toContain('href="data:text/css;charset=utf-8;base64,Q1NT"');
		expect(output).toContain('src="data:text/javascript;charset=utf-8;base64,SlM="');
		expect(output).toContain('src="data:image/png;base64,UE5H"');
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
		// The find script references the menu's marker (to skip its text), so assert
		// on the menu script tag itself rather than the bare attribute name.
		expect(output).not.toContain("<script data-dev3-artifact-menu>");
		expect(output).not.toContain("dev3-artifact-save-image");
	});

	it("always injects the find bridge, including its in-iframe ⌘F relay", () => {
		const output = composeArtifactDocument('<html><head></head><body><p>hello</p></body></html>', []);
		expect(output).toContain("data-dev3-artifact-find");
		// The parent drives the search; the iframe owns highlight + scroll.
		expect(output).toContain("dev3-artifact-find-result");
		expect(output).toContain("dev3-artifact-find-step");
		expect(output).toContain("dev3-artifact-find-clear");
		// Keydown never leaves the iframe, so ⌘F inside the artifact must be relayed.
		expect(output).toContain("dev3-artifact-find-open");
		expect(output).toContain("CSS.highlights");
	});

	it("publishes the resolved asset map so report code can build a src at runtime", () => {
		const output = composeArtifactDocument('<html><head></head><body></body></html>', [
			{ name: "shots/run.png", mime: "image/png", dataUrl: "data:image/png;base64,UlVO" },
		]);

		expect(output).toContain("window.__dev3ArtifactAssets=");
		expect(output).toContain('"shots/run.png":"data:image/png;base64,UlVO"');
		// A src the HTML scan never sees still resolves, so reports published before
		// dev3Artifact.asset() existed keep rendering.
		expect(output).toContain("MutationObserver");
		expect(output).toContain("img,source,video");
	});


	it("rewrites a bundled clip's video src, its source alternatives and its poster", () => {
		const html = [
			"<!doctype html><html><head></head><body>",
			'<video controls playsinline preload="metadata" poster="clips and posters/tour.png">',
			'<source src="clips and posters/tour.webm" type="video/webm">',
			'<source src="clips and posters/tour.mp4" type="video/mp4">',
			"</video>",
			'<video src="./clips%20and%20posters/tour.mp4"></video>',
			"</body></html>",
		].join("");
		const output = composeArtifactDocument(html, [
			{ name: "clips and posters/tour.mp4", mime: "video/mp4", dataUrl: "data:video/mp4;base64,TVA0" },
			{ name: "clips and posters/tour.webm", mime: "video/webm", dataUrl: "data:video/webm;base64,V0VC" },
			{ name: "clips and posters/tour.png", mime: "image/png", dataUrl: "data:image/png;base64,UE5H" },
		]);

		expect(output).toContain('poster="data:image/png;base64,UE5H"');
		expect(output).toContain('src="data:video/webm;base64,V0VC" type="video/webm"');
		expect(output).toContain('src="data:video/mp4;base64,TVA0" type="video/mp4"');
		// A percent-encoded relative path with spaces resolves to the same clip.
		expect(output).toContain('<video src="data:video/mp4;base64,TVA0">');
		// Nothing relative is left in the markup — the raw names survive only as keys
		// of the runtime map, which is what `dev3Artifact.asset()` reads.
		expect(output.slice(output.indexOf("<body"))).not.toContain("clips and posters/tour");
		expect(output).toContain('"clips and posters/tour.mp4":"data:video/mp4;base64,TVA0"');
		// Controls, playsinline and preload are the report's markup and must survive untouched.
		expect(output).toContain('controls playsinline preload="metadata"');
	});

	it("carries the blob retry for an engine that refuses a data: URL clip", () => {
		const output = composeArtifactDocument('<video src="clip.mp4"></video>', [
			{ name: "clip.mp4", mime: "video/mp4", dataUrl: "data:video/mp4;base64,TVA0" },
		]);

		expect(output).toContain("dev3VideoBlob");
		expect(output).toContain("URL.createObjectURL");
		// The retry is driven by the element's own error event, so a working engine never runs it.
		expect(output).toContain("document.addEventListener('error'");
	});

	it("escapes a closing script tag smuggled through an asset name", () => {
		const output = composeArtifactDocument("<html><head></head><body></body></html>", [
			{ name: "</script><script>alert(1)</script>.png", mime: "image/png", dataUrl: "data:image/png;base64,QQ==" },
		]);

		expect(output).not.toContain("</script><script>alert(1)");
		expect(output).toContain("\\u003c/script>");
	});

	it("injects the find bridge into bare-fragment artifacts too", () => {
		const output = composeArtifactDocument("<p>no html wrapper</p>", []);
		expect(output).toContain("data-dev3-artifact-find");
		expect(output).toContain("no html wrapper");
	});

	// The bridge's own behaviour is covered in artifactBridge.test.ts — here we only
	// assert it reaches the document with the capability the viewer asked for.
	it("injects the agent bridge carrying the requested capability flag", () => {
		const enabled = composeArtifactDocument("<p>report</p>", [], undefined, true);
		expect(enabled).toContain("data-dev3-artifact-bridge");
		expect(enabled).toContain('"canSend":true');

		expect(composeArtifactDocument("<p>report</p>", [], undefined, false)).toContain('"canSend":false');
		// Callers that pass no flag get the inert bridge, never a live one.
		expect(composeArtifactDocument("<p>report</p>", [])).toContain('"canSend":false');
	});
});
