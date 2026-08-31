import { resolveArtifactTransport } from "../artifactTransport";

describe("artifact transport", () => {
	it("isolates the artifact in its own process only on desktop macOS", () => {
		expect(resolveArtifactTransport({ remote: false, mac: true, tagDefined: true })).toBe("webview");
	});

	it("keeps the iframe in remote mode, where the webview tag does not exist", () => {
		expect(resolveArtifactTransport({ remote: true, mac: true, tagDefined: true })).toBe("frame");
		expect(resolveArtifactTransport({ remote: true, mac: false, tagDefined: false })).toBe("frame");
	});

	// Linux builds ship bundleCEF:false and the tag needs CEF; Windows (WebView2) is
	// simply unmeasured. Both would fail as a blank viewer, which is worse than the
	// freeze the webview would have contained.
	it("keeps the iframe off macOS until someone measures the tag there", () => {
		expect(resolveArtifactTransport({ remote: false, mac: false, tagDefined: true })).toBe("frame");
	});

	it("falls back to the iframe whenever the custom element is not registered", () => {
		expect(resolveArtifactTransport({ remote: false, mac: true, tagDefined: false })).toBe("frame");
	});
});
