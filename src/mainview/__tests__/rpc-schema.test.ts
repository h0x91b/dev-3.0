import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const sharedTypesPath = resolve(process.cwd(), "src/shared/types.ts");
const sharedTypesSource = readFileSync(sharedTypesPath, "utf8");

describe("AppRPCSchema webview messages", () => {
	it("declares desktop-only message ids used by the main process", () => {
		expect(sharedTypesSource).toContain("zoomIn: {};");
		expect(sharedTypesSource).toContain("zoomOut: {};");
		expect(sharedTypesSource).toContain("zoomReset: {};");
		expect(sharedTypesSource).toContain("qrTokenConsumed: {};");
		expect(sharedTypesSource).toContain("osc52Clipboard: { taskId: string; text: string; len: number };");
	});
});

describe("AppRPCSchema bun messages", () => {
	it("declares the CLI shared-image / shared-artifact push messages", () => {
		expect(sharedTypesSource).toContain("cliShowImage: {");
		expect(sharedTypesSource).toContain("images: SharedImage[];");
		expect(sharedTypesSource).toContain("cliShowArtifact: {");
		expect(sharedTypesSource).toContain("artifacts: SharedArtifact[];");
	});
});
