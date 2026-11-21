import { readdirSync, statSync } from "node:fs";

const DAY_FILE_RE = /^(\d{4})-(\d{2})-(\d{2})\.jsonl$/;

/** The local midnight a `YYYY-MM-DD.jsonl` name stands for, or null for any other (or impossible) name. */
export function parseDay(fileName: string): number | null {
	const match = DAY_FILE_RE.exec(fileName);
	if (!match) return null;
	const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
	const date = new Date(year, month - 1, day);
	if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
	return date.getTime();
}

/** On-disk size of each day-file in `dir`, keyed by `YYYY-MM-DD`. Stat only; a missing directory is empty. */
export function statDayFiles(dir: string): Array<{ day: string; bytes: number }> {
	const out: Array<{ day: string; bytes: number }> = [];
	try {
		for (const name of readdirSync(dir)) {
			if (parseDay(name) === null) continue;
			try {
				out.push({ day: name.slice(0, -".jsonl".length), bytes: statSync(`${dir}/${name}`).size });
			} catch {
				// Removed between the listing and the stat.
			}
		}
	} catch {
		// No directory yet, or unreadable.
	}
	return out;
}
