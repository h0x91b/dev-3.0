/**
 * Generate the model catalog Codex reads at launch, so a routed model stops
 * being an unknown slug served by placeholder metadata.
 *
 * The document is built by asking Codex itself for its built-in catalog and
 * cloning one of its entries — that is the only way to get an authentic system
 * prompt and tool contract for a model dev3 knows nothing about. Everything
 * here is best-effort: a missing binary, an unreadable dump or an unwritable
 * dir all mean "launch exactly as before", never a failed launch.
 */

import { mkdirSync, writeFileSync } from "fs";
import type { CodexModelCatalog, ModelCatalog } from "../shared/model-catalog";
import { buildCodexModelCatalog } from "../shared/model-catalog";
import { createLogger } from "./logger";
import { RUNTIME_DIR } from "./model-sidecar";
import { spawn } from "./spawn";

const log = createLogger("codex-model-catalog");

const CATALOG_PATH = `${RUNTIME_DIR}/codex-models.json`;

/** Codex dumps its catalog in milliseconds; anything slower is a broken install
 *  rather than a slow one, and a launch must not wait on it. */
const DUMP_TIMEOUT_MS = 5000;

async function dumpBuiltinCatalog(baseCmd: string): Promise<CodexModelCatalog | undefined> {
	const proc = spawn([baseCmd, "debug", "models"], { stdout: "pipe", stderr: "ignore" });
	const timer = setTimeout(() => proc.kill(9), DUMP_TIMEOUT_MS);
	try {
		const [text, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
		if (code !== 0) return undefined;
		const parsed = JSON.parse(text) as CodexModelCatalog;
		return Array.isArray(parsed?.models) && parsed.models.length > 0 ? parsed : undefined;
	} catch {
		return undefined;
	} finally {
		clearTimeout(timer);
	}
}

/** Write the generated catalog and return its path, or undefined to launch
 *  unchanged. */
export async function writeCodexModelCatalog(baseCmd: string, catalog: ModelCatalog): Promise<string | undefined> {
	const builtin = await dumpBuiltinCatalog(baseCmd);
	if (!builtin) {
		log.info(`${baseCmd} did not report its model catalog — launching with Codex's fallback metadata`);
		return undefined;
	}
	const generated = buildCodexModelCatalog(builtin, catalog);
	if (!generated) return undefined;
	try {
		mkdirSync(RUNTIME_DIR, { recursive: true, mode: 0o700 });
		writeFileSync(CATALOG_PATH, `${JSON.stringify(generated)}\n`, { mode: 0o600 });
		return CATALOG_PATH;
	} catch (err) {
		log.warn(`could not write the generated Codex model catalog: ${String(err)}`);
		return undefined;
	}
}
