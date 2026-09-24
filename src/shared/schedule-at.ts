import { resolveScheduleTarget } from "./schedule";

/**
 * `dev3 message --at` — every accepted spelling, resolved to one absolute instant.
 *
 *   14:00               next 14:00 on THIS machine's clock (today, else tomorrow)
 *   06:00Z              next 06:00 UTC
 *   06:00+03:00 / +0300 next 06:00 at that fixed offset
 *   2026-09-25T06:00Z   that exact instant (seconds optional; no zone = local)
 *
 * A bare time stays local because the "Send later" picker means local too; the
 * zone suffix exists so a UTC deadline never has to be converted by hand.
 * `nowMs` is injected, so every branch is deterministic under test.
 */
export function parseScheduleAt(raw: string, nowMs: number): Date | null {
	const value = raw.trim();

	const bare = /^(\d{1,2}):(\d{2})$/.exec(value);
	if (bare) return resolveScheduleTarget({ mode: "at", delayHours: 0, delayMinutes: 0, atTime: value }, nowMs);

	const zoned = /^(\d{1,2}):(\d{2})\s*(Z|UTC|[+-]\d{2}:?\d{2})$/i.exec(value);
	if (zoned) {
		const hh = Number(zoned[1]);
		const mm = Number(zoned[2]);
		const offsetMin = parseOffsetMinutes(zoned[3]);
		if (hh > 23 || mm > 59 || offsetMin === null) return null;
		// Wall clock "now" in the target offset, expressed through UTC getters.
		const there = new Date(nowMs + offsetMin * 60_000);
		let target = Date.UTC(there.getUTCFullYear(), there.getUTCMonth(), there.getUTCDate(), hh, mm) - offsetMin * 60_000;
		if (target <= nowMs) target += 86_400_000;
		return new Date(target);
	}

	const iso = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})(?::(\d{2}))?\s*(Z|UTC|[+-]\d{2}:?\d{2})?$/i.exec(value);
	if (iso) {
		const [, y, mo, d, h, mi, s, zone] = iso;
		const parts = [Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s ?? 0)] as const;
		if (parts[1] > 11 || parts[2] < 1 || parts[2] > 31 || parts[3] > 23 || parts[4] > 59 || parts[5] > 59) return null;
		let date: Date;
		if (zone) {
			const offsetMin = parseOffsetMinutes(zone);
			if (offsetMin === null) return null;
			date = new Date(Date.UTC(...parts) - offsetMin * 60_000);
		} else {
			date = new Date(...parts);
		}
		// Reject rollovers like 2026-02-31, which Date silently turns into March.
		const check = zone ? new Date(date.getTime() + (parseOffsetMinutes(zone) ?? 0) * 60_000) : date;
		const day = zone ? check.getUTCDate() : check.getDate();
		return day === parts[2] ? date : null;
	}
	return null;
}

function parseOffsetMinutes(zone: string): number | null {
	if (/^(Z|UTC)$/i.test(zone)) return 0;
	const m = /^([+-])(\d{2}):?(\d{2})$/.exec(zone);
	if (!m) return null;
	const hours = Number(m[2]);
	const minutes = Number(m[3]);
	if (hours > 14 || minutes > 59) return null;
	return (m[1] === "-" ? -1 : 1) * (hours * 60 + minutes);
}

/**
 * The confirmation line's time, in BOTH clocks so a zone mistake is visible the
 * moment it is made, not when the message fires hours off: "14:00 local
 * (Asia/Jerusalem) = 11:00 UTC". A date is added when either side is not today.
 */
export function describeScheduledTime(at: Date, nowMs: number, timeZone?: string): string {
	const zone = timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
	const local = formatIn(at, nowMs, zone);
	const utc = formatIn(at, nowMs, "UTC");
	return `${local} local (${zone}) = ${utc} UTC`;
}

function formatIn(at: Date, nowMs: number, timeZone: string): string {
	const day = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
	const time = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(at);
	return day(at) === day(new Date(nowMs)) ? time : `${day(at)} ${time}`;
}
