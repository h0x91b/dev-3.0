/**
 * Pull the `low-battery` rules from `h0x91b/toolbelt-for-agents` and bake them into
 * `src/shared/low-battery-content.generated.ts`. Runs before every build and in the
 * local dev loop, so a release and `bun run dev` carry byte-identical content.
 *
 * Fails loudly when upstream is unreachable: low-battery ships on by default, and a
 * release that silently lost it would advertise a feature it does not have. The
 * generated module is checked in, so tests and type-checking never need the network.
 */

import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { generateLowBatteryModule, type LowBatterySource } from "./low-battery-generator";

const UPSTREAM = process.env.DEV3_LOW_BATTERY_REPO ?? "https://github.com/h0x91b/toolbelt-for-agents.git";
const PLUGIN_DIR = "plugins/low-battery";
const OUT_FILE = join(import.meta.dir, "..", "src", "shared", "low-battery-content.generated.ts");

function run(args: string[], cwd?: string): string {
	const proc = Bun.spawnSync(args, { cwd, stderr: "pipe", stdout: "pipe" });
	if (proc.exitCode !== 0) {
		throw new Error(`\`${args.join(" ")}\` failed (${proc.exitCode}): ${proc.stderr.toString().trim()}`);
	}
	return proc.stdout.toString().trim();
}

/**
 * Upstream ships a 50 KB Gemini extension file that inlines the whole rule set.
 * dev3 gives Gemini the shared `~/.agents` skill instead (and actively deletes
 * `.gemini` duplicates), so baking it in would be dead weight in every binary.
 */
const SKIP_SKILL_FILES = new Set(["agents/gemini.toml"]);

/** Read a directory tree into path→contents, keyed relative to `root`. */
function readTree(root: string): Record<string, string> {
	const files: Record<string, string> = {};
	const walk = (dir: string): void => {
		for (const entry of readdirSync(dir)) {
			const full = join(dir, entry);
			if (statSync(full).isDirectory()) walk(full);
			else {
				const key = relative(root, full).split(sep).join("/");
				if (!SKIP_SKILL_FILES.has(key)) files[key] = readFileSync(full, "utf-8");
			}
		}
	};
	walk(root);
	return files;
}

const checkout = mkdtempSync(join(tmpdir(), "dev3-low-battery-"));
try {
	run(["git", "clone", "--depth", "1", "--filter=blob:none", UPSTREAM, checkout]);
	const revision = run(["git", "rev-parse", "HEAD"], checkout);

	const pluginRoot = join(checkout, PLUGIN_DIR);
	const source: LowBatterySource = {
		revision,
		outputStyle: readFileSync(join(pluginRoot, "output-styles/low-battery.md"), "utf-8"),
		skillFiles: readTree(join(pluginRoot, "skills/low-battery")),
	};

	writeFileSync(OUT_FILE, generateLowBatteryModule(source), "utf-8");
	console.log(`low-battery content generated from ${revision.slice(0, 8)} → ${relative(process.cwd(), OUT_FILE)}`);
} catch (err) {
	console.error("Failed to generate low-battery content — the build cannot ship a feature it advertises as on by default.");
	console.error(String(err));
	console.error(`Upstream: ${UPSTREAM}`);
	process.exit(1);
} finally {
	rmSync(checkout, { recursive: true, force: true });
}
