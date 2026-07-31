import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const templateDir = resolve(import.meta.dirname, "../../../assets/artifact-template");
const browser = [
	process.env.CHROME_BIN,
	"/Applications/Chromium.app/Contents/MacOS/Chromium",
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	"/usr/bin/google-chrome",
	"/usr/bin/chromium",
	"/usr/bin/chromium-browser",
].find((candidate): candidate is string => Boolean(candidate && existsSync(candidate)));
const tempDir = mkdtempSync(join(tmpdir(), "dev3-artifact-file-protocol-"));

afterAll(() => rmSync(tempDir, { recursive: true, force: true }));

/**
 * Startup of a real browser is ~2s idle but has been measured spiking past 20s
 * when several test suites and other headless browsers share the machine, so a
 * single fixed timeout makes this suite flaky for reasons unrelated to the
 * artifact template. Retrying with a wider budget keeps every assertion intact
 * while removing the load sensitivity.
 *
 * Deliberately NO `--user-data-dir`: a throwaway profile pays first-run
 * initialisation and was measured timing out at 40s where the shared profile
 * returns in 0.6s.
 */
const BROWSER_TIMEOUTS_MS = [30_000, 90_000];

function dumpDom(url: string): string {
	let lastError: unknown;
	for (const timeout of BROWSER_TIMEOUTS_MS) {
		try {
			return execFileSync(
				browser!,
				[
					"--headless",
					"--disable-gpu",
					"--disable-background-networking",
					"--force-prefers-reduced-motion=reduce",
					"--no-first-run",
					"--no-sandbox",
					"--host-resolver-rules=MAP cdnjs.cloudflare.com ~NOTFOUND",
					"--virtual-time-budget=1000",
					"--dump-dom",
					url,
				],
				{ encoding: "utf8", timeout, stdio: ["ignore", "pipe", "ignore"] },
			);
		} catch (err) {
			lastError = err;
		}
	}
	throw lastError;
}

describe.skipIf(!browser)("artifact starter through file://", () => {
	it("loads sibling CSS and classic scripts in a real browser", () => {
		for (const name of ["app.css", "app.js", "report.js", "dev3-icon.png"]) {
			copyFileSync(join(templateDir, name), join(tempDir, name));
		}
		const html = readFileSync(join(templateDir, "index.html"), "utf8")
			.replace(/\s*<link data-dev3-vendor=[^>]*>/g, "")
			.replace(/\s*<script data-dev3-vendor=[^>]*><\/script>/g, "")
			.replace(
				'<link rel="stylesheet" href="app.css" data-dev3-artifact-shell>',
				'<style>.choices__item--choice.is-selected { background-color: #f2f2f2; }</style><link rel="stylesheet" href="app.css" data-dev3-artifact-shell>',
			)
			.replace(
				"</body>",
				`<div id="choice-state-fixture" class="choices__list--dropdown" style="position:absolute;left:-9999px">
					<div id="choice-selected" class="choices__item choices__item--choice is-selected" aria-selected="false">Experiment</div>
					<div id="choice-highlighted" class="choices__item choices__item--choice is-highlighted" aria-selected="true">Decision</div>
				</div><script>
					document.documentElement.dataset.theme = "dark";
					document.body.dataset.fileProtocol = location.protocol;
					document.body.dataset.cssLoaded = Boolean(getComputedStyle(document.documentElement).getPropertyValue("--dev3-accent").trim());
					document.documentElement.style.scrollBehavior = "auto";
					function parseColor(value) {
						const channels = value.match(/[\\d.]+/g).map(Number);
						return { r: channels[0], g: channels[1], b: channels[2], a: channels[3] == null ? 1 : channels[3] };
					}
					function composite(front, back) {
						return {
							r: front.r * front.a + back.r * (1 - front.a),
							g: front.g * front.a + back.g * (1 - front.a),
							b: front.b * front.a + back.b * (1 - front.a),
							a: 1,
						};
					}
					function effectiveBackground(element) {
						const layers = [];
						for (let node = element; node instanceof Element; node = node.parentElement) {
							const color = parseColor(getComputedStyle(node).backgroundColor);
							if (color.a > 0) layers.push(color);
							if (color.a >= .999) break;
						}
						let result = { r: 255, g: 255, b: 255, a: 1 };
						for (let index = layers.length - 1; index >= 0; index -= 1) result = composite(layers[index], result);
						return result;
					}
					function luminance(color) {
						const channels = [color.r, color.g, color.b].map((value) => {
							const channel = value / 255;
							return channel <= .04045 ? channel / 12.92 : Math.pow((channel + .055) / 1.055, 2.4);
						});
						return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
					}
					function contrast(element) {
						const text = luminance(parseColor(getComputedStyle(element).color));
						const background = luminance(effectiveBackground(element));
						return (Math.max(text, background) + .05) / (Math.min(text, background) + .05);
					}
					document.body.dataset.choiceSelectedSafe = contrast(document.getElementById("choice-selected")) >= 4.5;
					document.body.dataset.choiceHighlightedSafe = contrast(document.getElementById("choice-highlighted")) >= 4.5;
					document.documentElement.dataset.theme = "light";
					document.body.dataset.choiceSelectedLightSafe = contrast(document.getElementById("choice-selected")) >= 4.5;
					document.body.dataset.choiceHighlightedLightSafe = contrast(document.getElementById("choice-highlighted")) >= 4.5;
					document.documentElement.dataset.theme = "dark";
					Element.prototype.scrollIntoView = () => {};
					const chartsLink = document.querySelector('.section-nav a[href="#charts"]');
					chartsLink.click();
					document.body.dataset.navCurrent = chartsLink.getAttribute("aria-current") || "";
					document.body.dataset.navFocus = document.activeElement.textContent.trim();
					document.body.dataset.navHash = location.hash;
				</script></body>`,
			);
		const htmlPath = join(tempDir, "index.html");
		writeFileSync(htmlPath, html);

		const output = dumpDom(pathToFileURL(htmlPath).href);

		expect(output).toContain('data-file-protocol="file:"');
		expect(output).toContain('data-css-loaded="true"');
		expect(output).toContain('data-nav-current="location"');
		expect(output).toContain('data-nav-focus="Delivery velocity"');
		expect(output).toContain('data-nav-hash="#charts"');
		expect(output).toContain('data-choice-selected-safe="true"');
		expect(output).toContain('data-choice-highlighted-safe="true"');
		expect(output).toContain('data-choice-selected-light-safe="true"');
		expect(output).toContain('data-choice-highlighted-light-safe="true"');
		expect(output).toContain("Artifact workspace");
		// Must outlast every browser attempt above, or vitest kills the retry.
	}, BROWSER_TIMEOUTS_MS.reduce((sum, ms) => sum + ms, 10_000));
});
