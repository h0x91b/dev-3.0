#!/usr/bin/env bun
/**
 * Regenerates the packed timezone→country table in `src/shared/timezone-country.ts`.
 *
 * Must be run with BUN, not node: the source of truth is
 * `Intl.Locale.prototype.getTimeZones()`, which JSC has and V8 (node 22) does not.
 * Baking the answer in is what lets every runtime — and every test — resolve a
 * country without that method and without a network call.
 *
 * `MODERN_ALIASES` exists because CLDR answers with the legacy zone names
 * (`Asia/Calcutta`, `Europe/Kiev`), while newer ICU builds are moving to the
 * canonical IANA ones. Both spellings must resolve, or a user's country silently
 * disappears the day their browser updates.
 */

const MODERN_ALIASES: Record<string, string> = {
	"Africa/Asmara": "ER",
	"America/Argentina/Buenos_Aires": "AR",
	"America/Argentina/Catamarca": "AR",
	"America/Argentina/Cordoba": "AR",
	"America/Argentina/Jujuy": "AR",
	"America/Argentina/Mendoza": "AR",
	"America/Atikokan": "CA",
	"America/Indiana/Indianapolis": "US",
	"America/Kentucky/Louisville": "US",
	"America/Nuuk": "GL",
	"Asia/Ho_Chi_Minh": "VN",
	"Asia/Kathmandu": "NP",
	"Asia/Kolkata": "IN",
	"Asia/Yangon": "MM",
	"Atlantic/Faroe": "FO",
	"Europe/Kyiv": "UA",
	"Pacific/Chuuk": "FM",
	"Pacific/Kanton": "KI",
	"Pacific/Pohnpei": "FM",
};

const REGION_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
type LocaleWithZones = Intl.Locale & { getTimeZones?: () => string[] | undefined };

if (typeof (Intl.Locale.prototype as LocaleWithZones).getTimeZones !== "function") {
	throw new Error("Intl.Locale.prototype.getTimeZones is missing — run this with bun, not node");
}

const byRegion = new Map<string, Set<string>>();
for (const a of REGION_LETTERS) {
	for (const b of REGION_LETTERS) {
		const region = `${a}${b}`;
		try {
			const zones = (new Intl.Locale(`und-${region}`) as LocaleWithZones).getTimeZones?.();
			if (zones?.length) byRegion.set(region, new Set(zones));
		} catch { /* not a region this build knows */ }
	}
}
for (const [zone, region] of Object.entries(MODERN_ALIASES)) {
	byRegion.get(region)?.add(zone);
}

const packed = [...byRegion.entries()]
	.sort(([a], [b]) => (a < b ? -1 : 1))
	.map(([region, zones]) => `${region}:${[...zones].sort().join(",")}`)
	.join("|");

const chunks: string[] = [];
for (let i = 0; i < packed.length; i += 100) chunks.push(packed.slice(i, i + 100));
const literal = chunks.map((c) => `\t${JSON.stringify(c)}`).join(" +\n");

const path = new URL("../src/shared/timezone-country.ts", import.meta.url).pathname;
const source = await Bun.file(path).text();
const start = source.indexOf("const PACKED =");
const end = source.indexOf(";\n", start);
if (start < 0 || end < 0) throw new Error("could not find the PACKED literal to replace");
await Bun.write(path, `${source.slice(0, start)}const PACKED =\n${literal}${source.slice(end)}`);

const zoneCount = [...byRegion.values()].reduce((n, z) => n + z.size, 0);
console.log(`[timezone-country] ${byRegion.size} regions, ${zoneCount} zones, ${packed.length} bytes`);
