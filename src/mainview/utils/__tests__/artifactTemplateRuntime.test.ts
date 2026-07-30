import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const templateDir = resolve(import.meta.dirname, "../../../assets/artifact-template");
const reportSource = readFileSync(resolve(templateDir, "report.js"), "utf8");
const appSource = readFileSync(resolve(templateDir, "app.js"), "utf8");

describe("artifact starter runtime", () => {
	afterEach(() => {
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
});
