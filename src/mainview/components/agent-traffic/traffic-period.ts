export function localDay(date: Date): string {
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function dayDate(day: string): Date {
	const [year, month, date] = day.split("-").map(Number);
	return new Date(year, month - 1, date);
}

export function isCalendarDay(value: string): boolean {
	return (
		/^\d{4}-\d{2}-\d{2}$/.test(value) && localDay(dayDate(value)) === value
	);
}

export function shiftDay(day: string, delta: number): string {
	const date = dayDate(day);
	date.setDate(date.getDate() + delta);
	return localDay(date);
}

export function trafficPeriodBounds(period: string, now: number) {
	if (isCalendarDay(period)) {
		return {
			start: dayDate(period).getTime(),
			end: dayDate(shiftDay(period, 1)).getTime(),
		};
	}
	return {
		start:
			period === "hour" ? now - 3600000 : period === "day" ? now - 86400000 : 0,
		end: Infinity,
	};
}
