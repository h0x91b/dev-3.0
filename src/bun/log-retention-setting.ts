import { resolveLogRetentionDays } from "../shared/log-retention";
import { createLogger } from "./logger";
import { loadSettingsSync, readLogRetentionForPrune } from "./settings";

const log = createLogger("log-retention");

/** The configured log retention in days (null = forever), for display. */
export function configuredLogRetentionDays(): number | null {
	return resolveLogRetentionDays(loadSettingsSync());
}

let lastSkipLoggedDay: string | null = null;

/**
 * The retention a daily prune may use, or null to skip this run: settings that
 * cannot be read, or a retention field that makes no sense, must not fall back to
 * a default that deletes history. The skip is logged once per day.
 */
export function pruneRetentionDays(now: Date): { days: number | null } | null {
	const retention = readLogRetentionForPrune();
	if (!retention && lastSkipLoggedDay !== now.toDateString()) {
		lastSkipLoggedDay = now.toDateString();
		log.warn("Skipping the log prune: settings.json is unreadable or its logRetentionDays is invalid");
	}
	return retention;
}
