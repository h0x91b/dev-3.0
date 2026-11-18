import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cliCommandSpecs } from "../cli/help";
import { buildCodexDev3Rules, CODEX_DEV3_RULES_FILE } from "../shared/codex-exec-policy";
import { POSIX_DEV3_CLI, resolveDev3CliPath, WINDOWS_DEV3_CLI_BASENAME } from "../shared/dev3-cli-path";
import { createLogger } from "./logger";

const log = createLogger("codex-rules");

/** Every way an agent may name the dev3 CLI as the first word of a command. */
export function dev3CliSpellings(userHome: string, platform: NodeJS.Platform = process.platform): string[] {
	if (platform === "win32") return ["dev3", WINDOWS_DEV3_CLI_BASENAME, resolveDev3CliPath({ platform })];
	return ["dev3", POSIX_DEV3_CLI, POSIX_DEV3_CLI.replace(/^~/, userHome)];
}

export function codexDev3RulesContent(userHome: string, platform: NodeJS.Platform = process.platform): string {
	return buildCodexDev3Rules(cliCommandSpecs(), dev3CliSpellings(userHome, platform));
}

/**
 * Write `<codexHome>/rules/dev3.rules`. The file is dev3's alone: Codex saves the
 * user's own approvals into `default.rules`, which this never reads or touches.
 */
export function ensureCodexDev3Rules(codexHome: string, userHome: string): void {
	const path = join(codexHome, "rules", CODEX_DEV3_RULES_FILE);
	const wanted = codexDev3RulesContent(userHome);
	try {
		let existing: string | null = null;
		try {
			existing = readFileSync(path, "utf-8");
		} catch {
			// Not written yet.
		}
		if (existing === wanted) return;
		mkdirSync(join(codexHome, "rules"), { recursive: true });
		writeFileSync(path, wanted, "utf-8");
		log.info("Codex dev3 rules written", { path });
	} catch (err) {
		log.warn("Failed to write the Codex dev3 rules (non-fatal)", { path, error: String(err) });
	}
}
