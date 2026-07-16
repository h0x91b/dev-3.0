#!/usr/bin/env bun

/**
 * Generate the native SwiftUI theme from the desktop design sources.
 *
 * Run from any directory with `bun ios/scripts/gen-theme.ts`. The generated
 * Swift file is committed so Xcode builds never depend on Bun at build time.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "../..");
export const THEME_OUTPUT_PATH = resolve(
	REPO_ROOT,
	"ios/Packages/Dev3UI/Sources/Dev3UI/Theme.swift",
);

const CSS_PATH = resolve(REPO_ROOT, "src/mainview/index.css");
const TYPES_PATH = resolve(REPO_ROOT, "src/shared/types.ts");
const TERMINAL_PATH = resolve(REPO_ROOT, "src/mainview/TerminalView.tsx");

export interface ThemeSourceText {
	css: string;
	types: string;
	terminal: string;
}

interface Rgba {
	red: number;
	green: number;
	blue: number;
	opacity: number;
}

interface NamedColor {
	caseName: string;
	sourceName: string;
	dark: Rgba;
	light: Rgba;
}

interface Metric {
	name: string;
	dark: number;
	light: number;
}

interface ParsedTheme {
	darkTokens: Record<string, string>;
	lightTokens: Record<string, string>;
	semanticColors: NamedColor[];
	metrics: Metric[];
	statuses: Array<{ caseName: string; wireName: string; dark: Rgba; light: Rgba }>;
	labels: Rgba[];
	terminal: {
		dark: Array<{ name: string; value: Rgba }>;
		light: Array<{ name: string; value: Rgba }>;
	};
}

const COMPOSITE_COLORS = [
	["glassColumn", "glass-column-rgb", "glass-column-alpha"],
	["glassCard", "glass-card-rgb", "glass-card-alpha"],
	["glassCardHover", "glass-card-rgb", "glass-card-hover-alpha"],
	["glassHeader", "glass-header-rgb", "glass-header-alpha"],
	["glassBorderColumn", "glass-border-rgb", "glass-border-column-alpha"],
	["glassBorderCard", "glass-border-rgb", "glass-border-card-alpha"],
	["glassBorderCardHover", "glass-border-rgb", "glass-border-card-hover-alpha"],
] as const;

const COLOR_NAME_OVERRIDES: Record<string, string> = {
	"bg-grad-from": "backgroundGradientStart",
	"bg-grad-mid": "backgroundGradientMiddle",
	"bg-grad-to": "backgroundGradientEnd",
	"hint-bg": "hintBackground",
	"hint-fg": "hintForeground",
};

const GLYPHS = [
	["terminal", "F120"],
	["chevronLeft", "F053"],
	["chevronRight", "F054"],
	["chevronDown", "F078"],
	["check", "F00C"],
	["windows", "F05C2"],
	["panes", "F0570"],
	["fileTree", "F0645"],
	["sourceBranch", "F0401"],
	["openInNew", "F0379"],
	["ethernet", "F0317"],
	["memory", "F035B"],
	["keyboard", "F030C"],
	["bolt", "F0E7"],
] as const;

function fail(message: string): never {
	throw new Error(`[gen-theme] ${message}`);
}

function camelCase(value: string): string {
	return value.replace(/-([a-z0-9])/g, (_, character: string) => character.toUpperCase());
}

function swiftCase(value: string): string {
	const candidate = camelCase(value);
	return candidate === "default" ? "defaultValue" : candidate;
}

function stripComment(value: string): string {
	return value.replace(/\/\*[\s\S]*?\*\//g, "").trim();
}

export function parseCssTheme(css: string, mode: "dark" | "light"): Record<string, string> {
	const selector = mode === "dark"
		? /:root,\s*\[data-theme="dark"\]\s*\{([\s\S]*?)\n\}/
		: /\[data-theme="light"\]\s*\{([\s\S]*?)\n\}/;
	const block = selector.exec(css)?.[1];
	if (!block) fail(`Could not find the ${mode} CSS theme block`);

	const tokens: Record<string, string> = {};
	for (const match of block.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)) {
		tokens[match[1]] = stripComment(match[2]);
	}
	if (Object.keys(tokens).length === 0) fail(`The ${mode} CSS theme has no tokens`);
	return tokens;
}

function parseHex(value: string): Rgba | null {
	const match = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(value);
	if (!match) return null;
	return {
		red: Number.parseInt(match[1].slice(0, 2), 16),
		green: Number.parseInt(match[1].slice(2, 4), 16),
		blue: Number.parseInt(match[1].slice(4, 6), 16),
		opacity: match[2] ? Number.parseInt(match[2], 16) / 255 : 1,
	};
}

function parseRgb(value: string): Rgba | null {
	const match = /^(\d{1,3})\s+(\d{1,3})\s+(\d{1,3})$/.exec(value);
	if (!match) return null;
	const channels = match.slice(1).map(Number);
	if (channels.some(channel => channel < 0 || channel > 255)) fail(`Invalid RGB value: ${value}`);
	return { red: channels[0], green: channels[1], blue: channels[2], opacity: 1 };
}

function parseColor(value: string): Rgba | null {
	return parseHex(value) ?? parseRgb(value);
}

function withOpacity(color: Rgba, value: string): Rgba {
	const opacity = Number(value);
	if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1) fail(`Invalid opacity: ${value}`);
	return { ...color, opacity };
}

function parseScalar(value: string): number | null {
	const match = /^(-?\d+(?:\.\d+)?)(?:px|deg)?$/.exec(value);
	return match ? Number(match[1]) : null;
}

function assertMatchingKeys(dark: Record<string, string>, light: Record<string, string>): void {
	const darkKeys = Object.keys(dark).sort();
	const lightKeys = Object.keys(light).sort();
	if (JSON.stringify(darkKeys) !== JSON.stringify(lightKeys)) {
		const darkOnly = darkKeys.filter(key => !(key in light));
		const lightOnly = lightKeys.filter(key => !(key in dark));
		fail(`Theme token mismatch (dark only: ${darkOnly.join(", ")}; light only: ${lightOnly.join(", ")})`);
	}
}

function parseObject(source: string, constant: string): Record<string, string> {
	const block = new RegExp(`const\\s+${constant}\\b[^=]*=\\s*\\{([\\s\\S]*?)\\n\\};`).exec(source)?.[1];
	if (!block) fail(`Could not find ${constant}`);
	const values: Record<string, string> = {};
	for (const match of block.matchAll(/(?:"([^"]+)"|([A-Za-z][A-Za-z0-9]*)):\s*"(#[0-9a-fA-F]{6,8})"/g)) {
		values[match[1] ?? match[2]] = match[3];
	}
	if (Object.keys(values).length === 0) fail(`${constant} has no color entries`);
	return values;
}

function parseLabels(source: string): Rgba[] {
	const block = /export const LABEL_COLORS\s*=\s*\[([\s\S]*?)\]\s*as const;/.exec(source)?.[1];
	if (!block) fail("Could not find LABEL_COLORS");
	return Array.from(block.matchAll(/"(#[0-9a-fA-F]{6})"/g), match => parseHex(match[1])!);
}

export function parseThemeSources(source: ThemeSourceText): ParsedTheme {
	const darkTokens = parseCssTheme(source.css, "dark");
	const lightTokens = parseCssTheme(source.css, "light");
	assertMatchingKeys(darkTokens, lightTokens);

	const semanticColors: NamedColor[] = [];
	for (const sourceName of Object.keys(darkTokens)) {
		if (sourceName.endsWith("-rgb")) continue;
		const dark = parseColor(darkTokens[sourceName]);
		const light = parseColor(lightTokens[sourceName]);
		if (!dark && !light) continue;
		if (!dark || !light) fail(`Color token ${sourceName} is not a color in both themes`);
		semanticColors.push({
			caseName: COLOR_NAME_OVERRIDES[sourceName] ?? camelCase(sourceName),
			sourceName,
			dark,
			light,
		});
	}

	for (const [caseName, rgbName, alphaName] of COMPOSITE_COLORS) {
		const darkRgb = parseRgb(darkTokens[rgbName]);
		const lightRgb = parseRgb(lightTokens[rgbName]);
		if (!darkRgb || !lightRgb || !(alphaName in darkTokens) || !(alphaName in lightTokens)) {
			fail(`Missing composite color inputs for ${caseName}`);
		}
		semanticColors.push({
			caseName,
			sourceName: `${rgbName} + ${alphaName}`,
			dark: withOpacity(darkRgb, darkTokens[alphaName]),
			light: withOpacity(lightRgb, lightTokens[alphaName]),
		});
	}

	const metrics: Metric[] = [];
	for (const sourceName of Object.keys(darkTokens)) {
		const dark = parseScalar(darkTokens[sourceName]);
		const light = parseScalar(lightTokens[sourceName]);
		if (dark === null && light === null) continue;
		if (dark === null || light === null) fail(`Metric token ${sourceName} is not numeric in both themes`);
		metrics.push({ name: camelCase(sourceName), dark, light });
	}

	const darkStatuses = parseObject(source.types, "STATUS_COLORS");
	const lightStatuses = parseObject(source.types, "STATUS_COLORS_LIGHT");
	assertMatchingKeys(darkStatuses, lightStatuses);
	const statuses = Object.keys(darkStatuses).map(wireName => ({
		caseName: swiftCase(wireName),
		wireName,
		dark: parseHex(darkStatuses[wireName])!,
		light: parseHex(lightStatuses[wireName])!,
	}));

	const darkTerminal = parseObject(source.terminal, "DARK_TERMINAL_THEME");
	const lightTerminal = parseObject(source.terminal, "LIGHT_TERMINAL_THEME");
	assertMatchingKeys(darkTerminal, lightTerminal);
	const terminal = {
		dark: Object.entries(darkTerminal).map(([name, value]) => ({ name, value: parseHex(value)! })),
		light: Object.entries(lightTerminal).map(([name, value]) => ({ name, value: parseHex(value)! })),
	};

	return {
		darkTokens,
		lightTokens,
		semanticColors,
		metrics,
		statuses,
		labels: parseLabels(source.types),
		terminal,
	};
}

function formatNumber(value: number): string {
	if (Number.isInteger(value)) return String(value);
	return value.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}

function rgba(value: Rgba): string {
	const opacity = value.opacity === 1 ? "" : `, opacity: ${formatNumber(value.opacity)}`;
	return `Dev3RGBA(red: ${value.red}, green: ${value.green}, blue: ${value.blue}${opacity})`;
}

function swiftString(value: string): string {
	return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function dictionaryLines(values: Record<string, string>): string {
	const entries = Object.entries(values);
	return entries
		.map(([key, value], index) =>
			`        "${key}": "${swiftString(value)}"${index === entries.length - 1 ? "" : ","}`)
		.join("\n");
}

function terminalInitializer(entries: Array<{ name: string; value: Rgba }>): string {
	return [
		"Dev3TerminalPalette(",
		...entries.map(({ name, value }, index) =>
			`            ${name}Value: ${rgba(value)}${index === entries.length - 1 ? "" : ","}`),
		"        )",
	].join("\n");
}

export function generateThemeSwift(source: ThemeSourceText): string {
	const parsed = parseThemeSources(source);
	const colorCases = parsed.semanticColors.map(color => `    case ${color.caseName}`).join("\n");
	const colorProperties = parsed.semanticColors.map(color => [
		`    public var ${color.caseName}: Color {`,
		`        color(.${color.caseName})`,
		"    }",
	].join("\n")).join("\n\n");
	const metricProperties = parsed.metrics.map(metric => `    public let ${metric.name}: Double`).join("\n");
	const metricArguments = (mode: "dark" | "light") => parsed.metrics
		.map((metric, index) =>
			`            ${metric.name}: ${formatNumber(metric[mode])}${index === parsed.metrics.length - 1 ? "" : ","}`)
		.join("\n");
	const statusCases = parsed.statuses
		.map(status => status.caseName === status.wireName
			? `    case ${status.caseName}`
			: `    case ${status.caseName} = "${status.wireName}"`)
		.join("\n");
	const terminalFields = parsed.terminal.dark
		.map(({ name }) => `    public let ${name}Value: Dev3RGBA`)
		.join("\n");
	const terminalProperties = parsed.terminal.dark.map(({ name }) => [
		`    public var ${name}: Color {`,
		`        ${name}Value.color`,
		"    }",
	].join("\n")).join("\n\n");

	const palette = (mode: "dark" | "light") => {
		const terminalEntries = parsed.terminal[mode];
		return [
			"Dev3ThemePalette(",
			"        semanticValues: [",
			...parsed.semanticColors.map((color, index) =>
				`            .${color.caseName}: ${rgba(color[mode])}${index === parsed.semanticColors.length - 1 ? "" : ","}`),
			"        ],",
			"        metrics: Dev3ThemeMetrics(",
			metricArguments(mode),
			"        ),",
			"        statusValues: [",
			...parsed.statuses.map((status, index) =>
				`            .${status.caseName}: ${rgba(status[mode])}${index === parsed.statuses.length - 1 ? "" : ","}`),
			"        ],",
			"        labelValues: [",
			...parsed.labels.map((value, index) =>
				`            ${rgba(value)}${index === parsed.labels.length - 1 ? "" : ","}`),
			"        ],",
			`        terminal: ${terminalInitializer(terminalEntries)}`,
			"    )",
		].join("\n");
	};

	const glyphs = GLYPHS
		.map(([name, codepoint]) => `    public static let ${name} = "\\u{${codepoint}}"`)
		.join("\n");

	return `// Generated by ios/scripts/gen-theme.ts from the desktop design sources. Do not edit.
// swiftlint:disable file_length

import SwiftUI

public struct Dev3RGBA: Equatable, Sendable {
    public let red: UInt8
    public let green: UInt8
    public let blue: UInt8
    public let opacity: Double

    public init(red: UInt8, green: UInt8, blue: UInt8, opacity: Double = 1) {
        self.red = red
        self.green = green
        self.blue = blue
        self.opacity = opacity
    }

    public var color: Color {
        Color(
            .sRGB,
            red: Double(red) / 255,
            green: Double(green) / 255,
            blue: Double(blue) / 255,
            opacity: opacity
        )
    }
}

public enum Dev3SemanticColor: String, CaseIterable, Sendable {
${colorCases}
}

public enum Dev3StatusToken: String, CaseIterable, Sendable {
${statusCases}
}

public struct Dev3ThemeMetrics: Sendable {
${metricProperties}
}

public struct Dev3TerminalPalette: Sendable {
${terminalFields}

${terminalProperties}
}

public struct Dev3ThemePalette: Sendable {
    private let semanticValues: [Dev3SemanticColor: Dev3RGBA]
    public let metrics: Dev3ThemeMetrics
    private let statusValues: [Dev3StatusToken: Dev3RGBA]
    public let labelValues: [Dev3RGBA]
    public let terminal: Dev3TerminalPalette

    fileprivate init(
        semanticValues: [Dev3SemanticColor: Dev3RGBA],
        metrics: Dev3ThemeMetrics,
        statusValues: [Dev3StatusToken: Dev3RGBA],
        labelValues: [Dev3RGBA],
        terminal: Dev3TerminalPalette
    ) {
        self.semanticValues = semanticValues
        self.metrics = metrics
        self.statusValues = statusValues
        self.labelValues = labelValues
        self.terminal = terminal
    }

    public func value(_ token: Dev3SemanticColor) -> Dev3RGBA {
        guard let value = semanticValues[token] else {
            preconditionFailure("Missing generated color token: \\(token.rawValue)")
        }
        return value
    }

    public func color(_ token: Dev3SemanticColor) -> Color {
        value(token).color
    }

    public func statusValue(_ status: Dev3StatusToken) -> Dev3RGBA {
        guard let value = statusValues[status] else {
            preconditionFailure("Missing generated status color: \\(status.rawValue)")
        }
        return value
    }

    public func statusColor(_ status: Dev3StatusToken) -> Color {
        statusValue(status).color
    }

    public func labelColor(at index: Int) -> Color {
        precondition(!labelValues.isEmpty, "Generated label palette is empty")
        let normalizedIndex = ((index % labelValues.count) + labelValues.count) % labelValues.count
        return labelValues[normalizedIndex].color
    }

${colorProperties}
}

public enum Dev3ThemeMode: String, CaseIterable, Sendable {
    case system
    case dark
    case light

    public func palette(systemColorScheme: ColorScheme) -> Dev3ThemePalette {
        switch self {
        case .system:
            Dev3Theme.palette(for: systemColorScheme)
        case .dark:
            Dev3Theme.dark
        case .light:
            Dev3Theme.light
        }
    }
}

public enum Dev3Theme {
    public static let dark = ${palette("dark")}

    public static let light = ${palette("light")}

    public static func palette(for colorScheme: ColorScheme) -> Dev3ThemePalette {
        colorScheme == .dark ? dark : light
    }
}

public extension Color {
    static func dev3(_ token: Dev3SemanticColor, scheme: ColorScheme) -> Color {
        Dev3Theme.palette(for: scheme).color(token)
    }

    static func dev3Status(_ status: Dev3StatusToken, scheme: ColorScheme) -> Color {
        Dev3Theme.palette(for: scheme).statusColor(status)
    }
}

public enum Dev3Glyph {
    public static let fontName = "JetBrainsMono Nerd Font Mono"
${glyphs}
}

public enum Dev3ThemeSourceTokens {
    public static let dark: [String: String] = [
${dictionaryLines(parsed.darkTokens)}
    ]

    public static let light: [String: String] = [
${dictionaryLines(parsed.lightTokens)}
    ]
}

// swiftlint:enable file_length
`;
}

export function readThemeSources(): ThemeSourceText {
	return {
		css: readFileSync(CSS_PATH, "utf8"),
		types: readFileSync(TYPES_PATH, "utf8"),
		terminal: readFileSync(TERMINAL_PATH, "utf8"),
	};
}

export async function writeGeneratedTheme(): Promise<void> {
	const content = generateThemeSwift(readThemeSources());
	await Bun.write(THEME_OUTPUT_PATH, content);
	console.log(`[gen-theme] wrote ${THEME_OUTPUT_PATH.replace(`${REPO_ROOT}/`, "")}`);
}

if (import.meta.main) {
	if (process.argv.includes("--check")) {
		const expected = generateThemeSwift(readThemeSources());
		const actual = readFileSync(THEME_OUTPUT_PATH, "utf8");
		if (actual !== expected) {
			console.error("[gen-theme] Theme.swift is stale. Run `bun ios/scripts/gen-theme.ts`.");
			process.exit(1);
		}
		console.log("[gen-theme] Theme.swift is current");
	} else {
		await writeGeneratedTheme();
	}
}
