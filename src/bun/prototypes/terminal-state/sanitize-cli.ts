#!/usr/bin/env bun
/**
 * Thin CLI over sanitizeJournal for the Windows matrix runner.
 *
 * Reads a raw capture journal and writes only shareable artifacts into the
 * share directory: a fixture for clean deterministic shell captures, and always
 * a metrics summary. Raw journal bytes never enter the share directory. Runs as
 * its own process (no Ghostty) so capture, replay, and sanitization stay
 * isolated on Bun 1.3.14 Windows.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { isRawSessionJournal } from "./session-journal";
import { sanitizeJournal } from "./sanitize-journal";

async function main(): Promise<void> {
	const journalPath = Bun.argv[2];
	const shareDir = Bun.argv[3];
	if (!journalPath || !shareDir) throw new Error("Usage: sanitize-cli.ts <journal.json> <share-dir>");

	const parsed: unknown = JSON.parse(await Bun.file(journalPath).text());
	if (!isRawSessionJournal(parsed)) throw new Error(`Not a session journal: ${journalPath}`);

	mkdirSync(shareDir, { recursive: true });
	const result = sanitizeJournal(parsed);
	const target = result.metrics.target;

	await Bun.write(join(shareDir, `${target}.metrics.json`), JSON.stringify(result.metrics, null, 2));
	if (result.mode === "fixture") {
		await Bun.write(
			join(shareDir, `${target}.sanitized-journal.json`),
			JSON.stringify(result.journal, null, 2),
		);
	}
	for (const warning of result.warnings) console.error(`WARNING: ${warning}`);
	console.log(
		`${target}: mode=${result.mode} bytes=${result.metrics.outputByteLength} ` +
			`sensitive=[${result.metrics.sensitiveCategories.join(",")}]`,
	);
}

if (import.meta.main) await main();
