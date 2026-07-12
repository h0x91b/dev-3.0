/**
 * Pure time-resolution for the shared in/at schedule picker — used by both the
 * "Start in…" deferred-launch UI (`LaunchVariantsModal`) and the "Send later"
 * scheduled-message UI (`ScheduleMessageModal`), via the extracted
 * `SchedulePicker` component. `nowMs` is always injected so the resolution is
 * deterministic and unit-testable (no wall-clock reads here).
 */

export type ScheduleMode = "in" | "at";

/** The picker's raw input state, resolved to a concrete target by {@link resolveScheduleTarget}. */
export interface ScheduleDraft {
	mode: ScheduleMode;
	/** "in" mode: relative delay hours (0–99). */
	delayHours: number;
	/** "in" mode: relative delay minutes (0–59). */
	delayMinutes: number;
	/** "at" mode: `HH:MM` local wall-clock (next occurrence today/tomorrow). */
	atTime: string;
}

/**
 * Resolve a picker draft to a concrete target `Date`, or `null` for a
 * zero/invalid delay or an unparseable/out-of-range time.
 * - `in`: `now + hours*60m + minutes`; a zero delay is invalid (`null`).
 * - `at`: the next occurrence of the local wall-clock time — today if still
 *   ahead of `now`, otherwise tomorrow.
 */
export function resolveScheduleTarget(draft: ScheduleDraft, nowMs: number): Date | null {
	if (draft.mode === "in") {
		const ms = draft.delayHours * 3_600_000 + draft.delayMinutes * 60_000;
		return ms > 0 ? new Date(nowMs + ms) : null;
	}
	const m = /^(\d{1,2}):(\d{2})$/.exec(draft.atTime);
	if (!m) return null;
	const hh = Number(m[1]);
	const mm = Number(m[2]);
	if (hh > 23 || mm > 59) return null;
	const d = new Date(nowMs);
	d.setHours(hh, mm, 0, 0);
	if (d.getTime() <= nowMs) d.setDate(d.getDate() + 1); // already passed → tomorrow
	return d;
}

/**
 * Whole-day offset between `target` and `now` using local-midnight boundaries:
 * `0` = today, `1` = tomorrow, etc. Pure; drives the "today/tomorrow" hint.
 */
export function scheduleDayOffset(target: Date, nowMs: number): number {
	const now = new Date(nowMs);
	const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
	return Math.round((startOfDay(target) - startOfDay(now)) / 86_400_000);
}

/** Format a `Date` as the `HH:MM` value expected by `<input type="time">`. */
export function toTimeInputValue(d: Date): string {
	return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
