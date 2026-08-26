import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const templateDir = resolve(import.meta.dirname, "../../../assets/artifact-template");
const reportSource = readFileSync(resolve(templateDir, "report.js"), "utf8");
const appSource = readFileSync(resolve(templateDir, "app.js"), "utf8");
const cssSource = readFileSync(resolve(templateDir, "app.css"), "utf8");
const htmlSource = readFileSync(resolve(templateDir, "index.html"), "utf8");

const textSizeControl =
	'<div class="segmented text-size"><button data-font-step="-1">A−</button><button id="fontScaleValue" data-font-step="0">100%</button><button data-font-step="1">A+</button></div>';

function shellApi<T>(): T {
	return (window as typeof window & { dev3Artifact: T }).dev3Artifact;
}

describe("artifact starter runtime", () => {
	afterEach(() => {
		localStorage.clear();
		document.documentElement.removeAttribute("style");
		document.documentElement.removeAttribute("data-theme");
		document.body.replaceChildren();
		delete (window as typeof window & { dev3Artifact?: unknown }).dev3Artifact;
	});

	it("keeps the shell independent from report data and tolerates removed demo panels", () => {
		document.body.innerHTML =
			'<button id="artifactTheme" type="button">◐ Auto</button><div id="toast"></div><details id="printDetails"><summary>Notes</summary><p>Evidence</p></details>';

		expect(() => window.eval(appSource)).not.toThrow();
		expect((window as typeof window & { dev3Artifact?: unknown }).dev3Artifact).toBeTruthy();
		expect(() => window.eval(reportSource)).not.toThrow();

		const details = document.getElementById("printDetails") as HTMLDetailsElement;
		expect(details.open).toBe(false);
		window.dispatchEvent(new Event("beforeprint"));
		expect(details.open).toBe(true);
		expect(document.documentElement.classList.contains("printing")).toBe(true);
		window.dispatchEvent(new Event("afterprint"));
		expect(details.open).toBe(false);
		expect(document.documentElement.classList.contains("printing")).toBe(false);
	});

	it("steps the root text scale between its bounds and resets from the readout", () => {
		document.body.innerHTML = `<div id="toast"></div>${textSizeControl}`;
		window.eval(appSource);

		const readout = document.getElementById("fontScaleValue") as HTMLButtonElement;
		const smaller = document.querySelector<HTMLButtonElement>('[data-font-step="-1"]')!;
		const larger = document.querySelector<HTMLButtonElement>('[data-font-step="1"]')!;
		const scale = () => document.documentElement.style.getPropertyValue("--dev3-font-scale-user");

		expect(scale()).toBe("1");
		expect(readout.disabled).toBe(true);

		larger.click();
		expect(scale()).toBe("1.1");
		expect(readout.textContent).toBe("110%");
		expect(readout.disabled).toBe(false);

		for (let step = 0; step < 8; step += 1) larger.click();
		expect(scale()).toBe("1.5");
		expect(larger.disabled).toBe(true);

		readout.click();
		expect(scale()).toBe("1");
		expect(readout.textContent).toBe("100%");

		for (let step = 0; step < 8; step += 1) smaller.click();
		expect(scale()).toBe("0.8");
		expect(smaller.disabled).toBe(true);
	});

	it("names the fix when chart() is called with an id instead of an element", () => {
		document.body.innerHTML = '<div id="toast"></div><div id="host"></div>';
		window.eval(appSource);
		const { chart } = shellApi<{ chart: (element: unknown, factory: () => unknown) => unknown }>();

		expect(() => chart("host", () => ({}))).toThrow(/getElementById\("host"\)/);
	});

	it("rejects an option passed to update() or remount() instead of ignoring it", () => {
		document.body.innerHTML = '<div id="toast"></div><div id="host"></div>';
		window.eval(appSource);
		const { chart } = shellApi<{ chart: (element: unknown, factory: () => unknown) => { update: (...args: unknown[]) => void; remount: (...args: unknown[]) => void } }>();
		// No window.echarts in happy-dom, so this is the offline no-op handle — the
		// argument guard has to sit in front of it, not behind a live chart.
		const handle = chart(document.getElementById("host"), () => ({}));

		expect(() => handle.update({ series: [] })).toThrow(/takes no arguments/);
		expect(() => handle.remount({ series: [] })).toThrow(/takes no arguments/);
		expect(() => handle.update()).not.toThrow();
	});

	it("resolves a runtime asset path through the viewer map and passes everything else through", () => {
		document.body.innerHTML = '<div id="toast"></div>';
		const scoped = window as typeof window & { __dev3ArtifactAssets?: Record<string, string> };
		scoped.__dev3ArtifactAssets = { "shots/run.png": "data:image/png;base64,UlVO" };
		window.eval(appSource);
		const { asset } = shellApi<{ asset: (path: string) => string }>();

		expect(asset("shots/run.png")).toBe("data:image/png;base64,UlVO");
		expect(asset("./shots/run.png")).toBe("data:image/png;base64,UlVO");
		expect(asset("https://example.com/x.png")).toBe("https://example.com/x.png");
		expect(asset("shots/missing.png")).toBe("shots/missing.png");
		delete scoped.__dev3ArtifactAssets;
		// No map (file:// and the extracted ZIP) — the relative path is already right.
		expect(asset("shots/run.png")).toBe("shots/run.png");
	});

	it("keeps the text-size control in the markup and every shell font size relative", () => {
		expect(htmlSource).toContain('data-font-step="-1"');
		expect(htmlSource).toContain('id="fontScaleValue"');
		expect(htmlSource).toContain('data-font-step="1"');
		expect(cssSource).toContain("font-size: calc(100% * var(--dev3-font-scale))");
		// A px font size anywhere in the shell is a block of the report that would
		// refuse to scale with the control.
		expect(cssSource.match(/font(-size)?: *[0-9.]+px/g)).toBeNull();
	});
});
