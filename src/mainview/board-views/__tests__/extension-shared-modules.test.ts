import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as React from "react";
import * as ReactJsxRuntime from "react/jsx-runtime";
import * as ReactDom from "react-dom";
import * as Cordis from "cordis";

const PUBLIC = resolve(__dirname, "../../public");

const SHIMS: Array<[string, string, Record<string, unknown>]> = [
	["react", "ext-shared/react.js", React],
	["react/jsx-runtime", "ext-shared/react-jsx-runtime.js", ReactJsxRuntime],
	["react-dom", "ext-shared/react-dom.js", ReactDom],
	["cordis", "ext-shared/cordis.js", Cordis],
];

function shimExports(file: string): string[] {
	const text = readFileSync(resolve(PUBLIC, file), "utf8");
	const block = /export const \{([^}]*)\} = m;/.exec(text)?.[1] ?? "";
	return block.split(",").map((name) => name.trim()).filter(Boolean).sort();
}

// An extension imports these by bare name; the import map in index.html sends each to a shim
// that re-exports the host's copy. A dependency bump that adds or drops an export must regenerate it.
describe("extension shared-module shims", () => {
	it.each(SHIMS)("%s re-exports exactly the host module's named exports", (specifier, file, mod) => {
		const expected = Object.keys(mod).filter((key) => key !== "default").sort();
		expect(shimExports(file)).toEqual(expected);
		expect(readFileSync(resolve(PUBLIC, file), "utf8")).toContain(`__dev3SharedModules["${specifier}"]`);
	});

	it("maps every shared specifier in the index.html import map", () => {
		const html = readFileSync(resolve(__dirname, "../../index.html"), "utf8");
		const map = JSON.parse(/<script type="importmap">([\s\S]*?)<\/script>/.exec(html)![1]);
		expect(map.imports).toEqual(Object.fromEntries(SHIMS.map(([specifier, file]) => [specifier, `/${file}`])));
	});
});
