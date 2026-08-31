import type { ArtifactTransport } from "./artifactChannel";
import { isMac, isRemote } from "./platform";

/**
 * Which host renders the artifact document. See
 * `decisions/2026/08/31/artifact-viewer-in-its-own-webview-process.md`.
 *
 * `webview` is the one that contains a runaway artifact, so it is what we want
 * everywhere — but only where the tag is known to work:
 *
 *  - **Remote (browser)** — there is no tag at all. Iframe. Same answer whenever
 *    the custom element is not registered, whatever the reason.
 *  - **macOS** — measured: the tag is a separate WebContent process and a wedged
 *    child leaves the app window beating. Webview.
 *  - **Linux** — Electrobun's own docs say the tag needs CEF, and this app builds
 *    with `bundleCEF: false`, so the tag would render nothing. Iframe.
 *  - **Windows** — WebView2, unverified. Not "probably fine": an unverified tag
 *    fails as a blank viewer, which is worse than the freeze it would prevent.
 *    Iframe until someone measures it.
 */
export function resolveArtifactTransport(env: { remote: boolean; mac: boolean; tagDefined: boolean }): ArtifactTransport {
	if (env.remote || !env.tagDefined) return "frame";
	return env.mac ? "webview" : "frame";
}

/** Electrobun's own preload registers the element long before this bundle runs. */
function webviewTagDefined(): boolean {
	if (typeof customElements === "undefined") return false;
	return Boolean(customElements.get("electrobun-webview"));
}

export function artifactTransport(): ArtifactTransport {
	return resolveArtifactTransport({ remote: isRemote(), mac: isMac(), tagDefined: webviewTagDefined() });
}
