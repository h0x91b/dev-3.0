/**
 * The last few things that happened to a terminal before it died.
 *
 * Every diagnostic we have describes the MOMENT of the crash — the error, the
 * dimensions it threw on, how many bytes the PTY had sent. None of them describes
 * the seconds BEFORE it, and that is the only place the trigger can be: both field
 * reports blame a resize (a resolution change, an artifact pane being dragged), and
 * successful resizes are never logged, so the claim cannot be confirmed or killed
 * from a log file.
 *
 * A bounded ring costs nothing while the terminal is healthy and is attached to
 * every error payload, so one log line carries its own run-up. Consecutive
 * identical entries collapse into a count, which is what makes a resize STORM
 * visible instead of pushing the interesting older entries out of the ring.
 */

export const BREADCRUMB_LIMIT = 16;

interface Breadcrumb {
	kind: string;
	detail: string;
	firstAt: number;
	lastAt: number;
	count: number;
}

export interface BreadcrumbTrail {
	/** Record one event. Repeats of the same event collapse instead of filling the ring. */
	note(kind: string, detail?: string): void;
	/** Oldest first, times relative to now: `-4.2s→-3.8s resize 158x82 x3`. */
	format(): string;
	entries(): number;
}

export function createBreadcrumbTrail(opts: { now?: () => number; limit?: number } = {}): BreadcrumbTrail {
	const now = opts.now ?? Date.now;
	const limit = opts.limit ?? BREADCRUMB_LIMIT;
	const ring: Breadcrumb[] = [];

	function stamp(at: number, crumb: Breadcrumb): string {
		const ago = (ms: number) => `-${((at - ms) / 1000).toFixed(1)}s`;
		const when = crumb.count > 1 ? `${ago(crumb.firstAt)}→${ago(crumb.lastAt)}` : ago(crumb.lastAt);
		const what = crumb.detail ? `${crumb.kind} ${crumb.detail}` : crumb.kind;
		return crumb.count > 1 ? `${when} ${what} x${crumb.count}` : `${when} ${what}`;
	}

	return {
		note(kind, detail = "") {
			const at = now();
			const last = ring[ring.length - 1];
			if (last && last.kind === kind && last.detail === detail) {
				last.lastAt = at;
				last.count += 1;
				return;
			}
			ring.push({ kind, detail, firstAt: at, lastAt: at, count: 1 });
			if (ring.length > limit) ring.shift();
		},
		format() {
			const at = now();
			return ring.map((crumb) => stamp(at, crumb)).join(" | ");
		},
		entries: () => ring.length,
	};
}
