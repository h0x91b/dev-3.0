import type { KeyboardEvent } from "react";

/**
 * Arrow-key navigation for a `role="radiogroup"` built from buttons.
 *
 * A radiogroup promises arrow keys; without them the role is a lie to a screen
 * reader. Enabled options only — arrowing onto a disabled choice would look like
 * the selection took and then silently didn't.
 */
export function handleRadioGroupKeys<T>(
	event: KeyboardEvent<HTMLElement>,
	options: readonly T[],
	current: T,
	select: (next: T) => void,
): void {
	const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
	if (step === 0 || options.length === 0) return;
	event.preventDefault();
	const from = options.indexOf(current);
	const next = options[(((from < 0 ? 0 : from) + step) % options.length + options.length) % options.length];
	if (next !== current) select(next);
}
