import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseCssTheme, readThemeSources } from "./gen-theme";

const REPO_ROOT = resolve(import.meta.dir, "../..");
const ASSETS_ROOT = resolve(REPO_ROOT, "ios/App/Resources/Assets.xcassets");

interface PngMetadata {
	width: number;
	height: number;
	colorType: number;
}

async function pngMetadata(path: string): Promise<PngMetadata> {
	const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
	expect([...bytes.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	return {
		width: view.getUint32(16),
		height: view.getUint32(20),
		colorType: view.getUint8(25),
	};
}

function rgbBytes(components: Record<string, string>): [number, number, number] {
	return [components.red, components.green, components.blue].map(value =>
		Math.round(Number(value) * 255),
	) as [number, number, number];
}

function cssRgb(value: string): [number, number, number] {
	return value.split(/\s+/).map(Number) as [number, number, number];
}

describe("iOS branding assets", () => {
	test("ships one opaque 1024px app icon", async () => {
		const catalog = JSON.parse(
			readFileSync(resolve(ASSETS_ROOT, "AppIcon.appiconset/Contents.json"), "utf8"),
		);
		expect(catalog.images).toEqual([
			{
				filename: "AppIcon-1024.png",
				idiom: "universal",
				platform: "ios",
				size: "1024x1024",
			},
		]);

		const metadata = await pngMetadata(
			resolve(ASSETS_ROOT, "AppIcon.appiconset/AppIcon-1024.png"),
		);
		expect(metadata).toEqual({ width: 1024, height: 1024, colorType: 2 });
	});

	test("uses the semantic surface-base token behind the launch mark", () => {
		const source = readThemeSources();
		const darkTokens = parseCssTheme(source.css, "dark");
		const lightTokens = parseCssTheme(source.css, "light");
		const catalog = JSON.parse(
			readFileSync(resolve(ASSETS_ROOT, "LaunchBackground.colorset/Contents.json"), "utf8"),
		);

		const light = catalog.colors.find((entry: { appearances?: unknown }) => !entry.appearances);
		const dark = catalog.colors.find((entry: { appearances?: unknown }) => entry.appearances);
		expect(rgbBytes(light.color.components)).toEqual(cssRgb(lightTokens["surface-base"]));
		expect(rgbBytes(dark.color.components)).toEqual(cssRgb(darkTokens["surface-base"]));
	});

	test("ships correctly scaled launch artwork and native launch references", async () => {
		const launchImages = [
			["LaunchMark.png", 128],
			["LaunchMark@2x.png", 256],
			["LaunchMark@3x.png", 384],
		] as const;
		for (const [filename, size] of launchImages) {
			const metadata = await pngMetadata(resolve(ASSETS_ROOT, `LaunchMark.imageset/${filename}`));
			expect(metadata.width).toBe(size);
			expect(metadata.height).toBe(size);
		}

		const infoPlist = readFileSync(resolve(REPO_ROOT, "ios/App/Info.plist"), "utf8");
		expect(infoPlist).toContain("<key>UIColorName</key>\n        <string>LaunchBackground</string>");
		expect(infoPlist).toContain("<key>UIImageName</key>\n        <string>LaunchMark</string>");
		expect(infoPlist).toContain("<key>UIImageRespectsSafeAreaInsets</key>\n        <true/>");

		const projectSpec = readFileSync(resolve(REPO_ROOT, "ios/project.yml"), "utf8");
		expect(projectSpec).toContain("- path: App/Resources\n        buildPhase: resources");
	});
});
