/**
 * Turn the artifact popup on again after a session that stopped responding with
 * an artifact on screen.
 *
 * What is actually known: on some machines the window stops running JavaScript
 * while an HTML artifact is open in the docked panel, and opening artifacts as a
 * popup instead makes it stop happening. The cause is NOT established, so nothing
 * here claims one — this is association, and the recovery is the user's own
 * existing workaround (`openArtifactsInPopup`) applied for them.
 *
 * The evidence is written by the host at the moment it sees the silence
 * (`renderer-watchdog.ts`), because the renderer cannot report its own freeze and
 * the app may never quit cleanly afterwards. A missing clean-exit marker proves
 * nothing on its own and is deliberately not used as a signal: only a measured
 * stretch of host-observed silence from a visible desktop window with an artifact
 * in it counts.
 *
 * Limitation, stated rather than papered over: the host can only see that the
 * RENDERER went quiet. If the whole process — host included — wedges, this file
 * is never written and the freeze leaves no record at all.
 *
 * The record lives in its own file next to `settings.json`. It is additive: an
 * older co-installed build never reads it, nothing is renamed, nothing already on
 * disk is rewritten (see the on-disk invariants in AGENTS.md).
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createLogger } from "./logger";
import { DEV3_HOME } from "./paths";
import { loadSettings, saveSettings } from "./settings";

const log = createLogger("artifact-freeze");

const RECORD_FILE = `${DEV3_HOME}/artifact-freeze-recovery.json`;

/** Evidence older than this is about a build and a machine state long gone. */
export const EVIDENCE_STALE_MS = 14 * 24 * 60 * 60 * 1_000;
/**
 * A window that came back on its own this quickly was slow, not frozen. The
 * symptom being recovered from is a window that never came back.
 */
export const SELF_RECOVERY_MS = 60_000;

export interface ArtifactFreezeEvidence {
	/** When the silence crossed the evidence threshold, host clock. */
	at: number;
	quietForMs: number;
	/** An artifact was still mounted when the window went quiet. */
	artifactOpen: boolean;
	/** Age of the last artifact open/close in that window; null = none this page load. */
	artifactIdleMs: number | null;
	/** Set once the same window starts beating again. */
	recoveredAfterMs?: number;
}

interface FreezeRecord {
	version: 1;
	/** The one unconsumed piece of evidence. A newer freeze replaces an older one. */
	pending?: ArtifactFreezeEvidence;
	/** Waiting to be told to the user, once. */
	notice?: { freezeAt: number; enabledAt: number };
	autoEnabledAt?: number;
	autoEnableCount?: number;
	/** The user turned the popup off after we turned it on. Their choice is final. */
	declinedAt?: number;
	lastFreezeAt?: number;
}

const EMPTY: FreezeRecord = { version: 1 };

function readRecord(): FreezeRecord {
	try {
		if (!existsSync(RECORD_FILE)) return { ...EMPTY };
		const parsed = JSON.parse(readFileSync(RECORD_FILE, "utf-8")) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ...EMPTY };
		const raw = parsed as Record<string, unknown>;
		return {
			version: 1,
			pending: sanitizeEvidence(raw.pending),
			notice: sanitizeNotice(raw.notice),
			autoEnabledAt: num(raw.autoEnabledAt),
			autoEnableCount: num(raw.autoEnableCount),
			declinedAt: num(raw.declinedAt),
			lastFreezeAt: num(raw.lastFreezeAt),
		};
	} catch (err) {
		// A corrupt record must never cost the user their app or their settings.
		log.warn("freeze record unreadable — starting from empty", { error: String(err) });
		return { ...EMPTY };
	}
}

function num(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function sanitizeEvidence(raw: unknown): ArtifactFreezeEvidence | undefined {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const r = raw as Record<string, unknown>;
	const at = num(r.at);
	const quietForMs = num(r.quietForMs);
	if (at === undefined || quietForMs === undefined) return undefined;
	return {
		at,
		quietForMs,
		artifactOpen: r.artifactOpen === true,
		artifactIdleMs: num(r.artifactIdleMs) ?? null,
		...(num(r.recoveredAfterMs) !== undefined ? { recoveredAfterMs: num(r.recoveredAfterMs) } : {}),
	};
}

function sanitizeNotice(raw: unknown): FreezeRecord["notice"] {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const r = raw as Record<string, unknown>;
	const freezeAt = num(r.freezeAt);
	const enabledAt = num(r.enabledAt);
	return freezeAt !== undefined && enabledAt !== undefined ? { freezeAt, enabledAt } : undefined;
}

function writeRecord(record: FreezeRecord): void {
	try {
		mkdirSync(DEV3_HOME, { recursive: true });
		const temp = `${RECORD_FILE}.tmp`;
		writeFileSync(temp, JSON.stringify(record, null, 2), "utf-8");
		renameSync(temp, RECORD_FILE);
	} catch (err) {
		log.warn("failed to write the freeze record", { error: String(err) });
	}
}

/**
 * Called from the watchdog while the window is still silent. Synchronous on
 * purpose: the app may be force-quit seconds from now, and an awaited write that
 * never lands is the same as no evidence at all.
 */
export function recordArtifactFreezeEvidence(evidence: ArtifactFreezeEvidence): void {
	const record = readRecord();
	record.pending = evidence;
	record.lastFreezeAt = evidence.at;
	writeRecord(record);
	log.warn("artifact-associated freeze recorded", {
		quietForMs: evidence.quietForMs,
		artifactOpen: evidence.artifactOpen,
		artifactIdleMs: evidence.artifactIdleMs,
	});
}

/** The same window started beating again — the freeze was a stall after all. */
export function markArtifactFreezeRecovered(afterMs: number): void {
	const record = readRecord();
	if (!record.pending || record.pending.recoveredAfterMs !== undefined) return;
	record.pending.recoveredAfterMs = afterMs;
	writeRecord(record);
	log.info("the window that went quiet came back", { afterMs });
}

export type RecoveryOutcome =
	| { enabled: true; freezeAt: number }
	| { enabled: false; reason: "no-evidence" | "stale" | "self-recovered" | "already-on" | "user-declined" };

/**
 * Startup step. Must run BEFORE the first window loads, or the first artifact of
 * the new session reopens in the presentation we are recovering from.
 *
 * Idempotent by construction: evidence is consumed whatever the verdict, so a
 * second launch has nothing left to act on and the setting is never toggled twice
 * for one freeze.
 */
export async function applyArtifactFreezeRecovery(now = Date.now()): Promise<RecoveryOutcome> {
	const record = readRecord();
	const pending = record.pending;
	if (!pending) return { enabled: false, reason: "no-evidence" };

	// Consume first: one freeze gets one decision, and a decision we cannot make
	// (stale, declined) must not be retried on every launch forever.
	delete record.pending;

	if (now - pending.at > EVIDENCE_STALE_MS) {
		writeRecord(record);
		log.info("ignoring stale freeze evidence", { ageMs: now - pending.at });
		return { enabled: false, reason: "stale" };
	}
	if (pending.recoveredAfterMs !== undefined && pending.recoveredAfterMs < SELF_RECOVERY_MS) {
		writeRecord(record);
		log.info("the window recovered on its own — not switching presentation", { afterMs: pending.recoveredAfterMs });
		return { enabled: false, reason: "self-recovered" };
	}
	if (record.declinedAt !== undefined) {
		writeRecord(record);
		log.info("the user chose the panel after a recovery — leaving their choice alone");
		return { enabled: false, reason: "user-declined" };
	}

	const settings = await loadSettings();
	if (settings.openArtifactsInPopup === true) {
		// Already where the recovery would put it: no write, no notice, no noise.
		writeRecord(record);
		return { enabled: false, reason: "already-on" };
	}
	if (record.autoEnabledAt !== undefined && settings.openArtifactsInPopup === false) {
		// We enabled it before and it is off again: that can only be the user. Stop.
		record.declinedAt = now;
		writeRecord(record);
		log.info("popup mode was turned off again after a recovery — standing down for good");
		return { enabled: false, reason: "user-declined" };
	}

	await saveSettings({ ...settings, openArtifactsInPopup: true });
	record.autoEnabledAt = now;
	record.autoEnableCount = (record.autoEnableCount ?? 0) + 1;
	record.notice = { freezeAt: pending.at, enabledAt: now };
	writeRecord(record);
	log.warn("artifacts switched to the popup after a frozen session", {
		quietForMs: pending.quietForMs,
		autoEnableCount: record.autoEnableCount,
	});
	return { enabled: true, freezeAt: pending.at };
}

/** One-shot read for the renderer: the notice is shown once and never again. */
export function consumeArtifactFreezeNotice(): { freezeAt: number } | null {
	const record = readRecord();
	if (!record.notice) return null;
	const freezeAt = record.notice.freezeAt;
	delete record.notice;
	writeRecord(record);
	return { freezeAt };
}

/**
 * The user moved the popup switch themselves. Turning it off after we turned it
 * on ends the recovery for good — retrying it would be arguing with them.
 */
export function noteArtifactPopupPreference(value: boolean | undefined): void {
	const record = readRecord();
	if (record.autoEnabledAt === undefined) return;
	if (value === false && record.declinedAt === undefined) {
		record.declinedAt = Date.now();
		delete record.notice;
		writeRecord(record);
		log.info("popup mode turned off by the user — no further automatic recovery");
	} else if (value === true && record.declinedAt !== undefined) {
		// Back on by their own hand: the standing-down is over too.
		delete record.declinedAt;
		writeRecord(record);
	}
}

/** Test seam only. */
export const freezeRecordPathForTests = RECORD_FILE;
