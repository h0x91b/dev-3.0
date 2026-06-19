#!/usr/bin/env bun
/**
 * Regenerates the "Show all tips" list inside docs/index.html from the in-app
 * tip registry, so the landing page stays in sync with the real feature tips.
 *
 * Reads src/mainview/tips.ts (order + score) and the English strings in
 * src/mainview/i18n/translations/en/tips.ts, then rewrites the block between
 * the <!-- TIPS:FULL:START --> / <!-- TIPS:FULL:END --> sentinels and updates
 * the "Show all N tips" count. Run after adding or editing tips:
 *
 *   bun scripts/generate-landing-tips.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const TIPS_TS = join(ROOT, "src/mainview/tips.ts");
const EN_TIPS = join(ROOT, "src/mainview/i18n/translations/en/tips.ts");
const INDEX = join(ROOT, "docs/index.html");

const escapeHtml = (s: string) =>
	s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Build key -> English text map.
const enSrc = readFileSync(EN_TIPS, "utf8");
const strings = new Map<string, string>();
for (const m of enSrc.matchAll(/"(tip\.[^"]+)":\s*"((?:[^"\\]|\\.)*)"/g)) {
	strings.set(m[1], JSON.parse(`"${m[2]}"`));
}

// Extract tips (titleKey, bodyKey, score) in registry order.
const tipsSrc = readFileSync(TIPS_TS, "utf8");
const tips: { titleKey: string; bodyKey: string; score: number }[] = [];
for (const m of tipsSrc.matchAll(
	/titleKey:\s*"([^"]+)"[\s\S]*?bodyKey:\s*"([^"]+)"[\s\S]*?score:\s*(\d+)/g,
)) {
	tips.push({ titleKey: m[1], bodyKey: m[2], score: Number(m[3]) });
}

// Highest-coolness first, stable within a tier (mirrors the in-app ordering).
const ordered = tips
	.map((t, i) => ({ ...t, i }))
	.sort((a, b) => b.score - a.score || a.i - b.i);

const rows = ordered
	.map((t) => {
		const title = strings.get(t.titleKey);
		const body = strings.get(t.bodyKey);
		if (!title || !body) throw new Error(`Missing string for ${t.titleKey}`);
		return `        <div class="tip-row"><b>${escapeHtml(title)}</b><span>${escapeHtml(body)}</span></div>`;
	})
	.join("\n");

let html = readFileSync(INDEX, "utf8");

const block = `<!-- TIPS:FULL:START -->\n${rows}\n        <!-- TIPS:FULL:END -->`;
html = html.replace(
	/<!-- TIPS:FULL:START -->[\s\S]*?<!-- TIPS:FULL:END -->/,
	block,
);

// Round the count down to a tidy "N+" so it does not churn on every tiny edit.
const floored = Math.floor(tips.length / 10) * 10;
html = html.replace(
	/<span class="tips-more-label">[^<]*<\/span>/,
	`<span class="tips-more-label">Show all ${floored}+ tips</span>`,
);

writeFileSync(INDEX, html);
console.log(`Wrote ${tips.length} tips (label: ${floored}+) into docs/index.html`);
