/**
 * The external-sender registry: `~/.dev3.0/external-senders.json`, edited by
 * hand and only ever READ by the app — no settings save and no RPC writes it, so
 * registering a sender is always the user's own act.
 *
 *   {"senders": {"openclaw:home:main": {"label": "OpenClaw main (home)"}}}
 *
 * Read on every call: it is tiny, and a hand edit takes effect without a restart.
 */

import { readFileSync } from "node:fs";
import {
	type ExternalSender,
	isValidSenderId,
	UNKNOWN_EXTERNAL_SENDER_ERROR,
} from "../shared/external-senders";
import { DEV3_HOME } from "./paths";
import { createLogger } from "./logger";

const log = createLogger("external-senders");

export function externalSendersRegistryPath(): string {
	return `${DEV3_HOME}/external-senders.json`;
}

/** Every valid entry; a missing or unreadable file means no senders. */
export function loadExternalSenders(): ExternalSender[] {
	let raw: string;
	try {
		raw = readFileSync(externalSendersRegistryPath(), "utf8");
	} catch {
		return [];
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		log.warn("external-senders.json is not valid JSON; no senders are registered", { error: String(err) });
		return [];
	}
	const senders = (parsed as { senders?: unknown } | null)?.senders;
	if (!senders || typeof senders !== "object" || Array.isArray(senders)) return [];
	const result: ExternalSender[] = [];
	for (const [id, entry] of Object.entries(senders as Record<string, unknown>)) {
		if (!isValidSenderId(id)) {
			log.warn("Ignoring an external sender with an invalid id", { id });
			continue;
		}
		const label = (entry as { label?: unknown } | null)?.label;
		result.push({ id, label: typeof label === "string" && label.trim() ? label.trim() : id });
	}
	return result;
}

/** The registered sender, or an error the CLI turns into its own exit code. */
export function requireExternalSender(id: unknown): ExternalSender {
	const wanted = typeof id === "string" ? id.trim() : "";
	const found = loadExternalSenders().find((s) => s.id === wanted);
	if (!found) {
		throw new Error(
			`${UNKNOWN_EXTERNAL_SENDER_ERROR} "${wanted}". Register it in ${externalSendersRegistryPath()} ` +
				`as {"senders": {"${wanted || "<id>"}": {"label": "…"}}}.`,
		);
	}
	return found;
}
