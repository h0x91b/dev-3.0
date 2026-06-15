import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { DEV3_HOME } from "./paths";
import { createLogger } from "./logger";

const log = createLogger("vents");

/**
 * Local-only "vent" feedback store. Each vent is a standalone anonymous
 * markdown file under ~/.dev3.0/vents/. This is how an AI agent reports
 * friction with the dev3 platform itself (CLI, skill, tmux integration, docs)
 * directly to the user running it — no server, no network, no GitHub issue.
 *
 * ANONYMITY IS THE WHOLE POINT: we never enrich a vent with any context.
 * No project path, no project/task id, no cwd, no code snippets — the file
 * contains only the agent-supplied name + markdown body plus a timestamp.
 * The strict "platform-only, no PII, no project specifics" contract is taught
 * to the agent in the skill; here we additionally guarantee zero enrichment.
 */
export const VENTS_DIR = `${DEV3_HOME}/vents`;

/** Caps so an injected or runaway model can't write megabytes to disk. */
const MAX_NAME_LEN = 120;
const MAX_CONTENT_LEN = 8000;

export interface VentResult {
	fileName: string;
	path: string;
	name: string;
}

function pad(n: number): string {
	return String(n).padStart(2, "0");
}

/** Lowercase kebab slug, ASCII-only, capped — used only for the filename. */
function slugify(name: string): string {
	const slug = name
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 60)
		.replace(/-+$/g, "");
	return slug || "vent";
}

/**
 * Write a single anonymous vent markdown file. The filename leads with the
 * full date + time (YYYY-MM-DD_HH-MM) so vents sort chronologically, followed
 * by a short slug of the name. Collisions within the same minute get a numeric
 * suffix. `now` is injectable for deterministic tests.
 */
export function addVent(name: string, content: string, now: Date = new Date()): VentResult {
	const cleanName = name.trim().slice(0, MAX_NAME_LEN) || "Untitled vent";
	const cleanContent = content.trim().slice(0, MAX_CONTENT_LEN);

	const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
	const time = `${pad(now.getHours())}-${pad(now.getMinutes())}`;
	const slug = slugify(cleanName);

	mkdirSync(VENTS_DIR, { recursive: true });

	let fileName = `${date}_${time}_${slug}.md`;
	let path = `${VENTS_DIR}/${fileName}`;
	let suffix = 2;
	while (existsSync(path)) {
		fileName = `${date}_${time}_${slug}-${suffix}.md`;
		path = `${VENTS_DIR}/${fileName}`;
		suffix++;
	}

	const header = `# ${cleanName}\n\n_${date} ${time.replace("-", ":")}_\n\n`;
	const body = `${header}${cleanContent}\n`;
	writeFileSync(path, body, "utf-8");

	log.info("Vent recorded", { fileName });
	return { fileName, path, name: cleanName };
}
