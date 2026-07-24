/**
 * Fake clock + deterministic scheduler for the native-terminal load/budget
 * harness. Both replace the parser pipeline's real time and macrotask seams
 * (`now` and `schedule`) so scenarios never sleep and never race the event loop.
 *
 * `SteppingClock` advances a fixed step per read, so every synchronous
 * `drainNow` (which reads `now()` at start and end) measures the same latency —
 * turning wall-clock timing into a pinned, assertable number.
 */

export class SteppingClock {
	private t: number;

	constructor(
		private readonly step = 1,
		start = 0,
	) {
		this.t = start;
	}

	/** Bound reader passed as the pipeline's `now` seam; advances on each call. */
	readonly now = (): number => {
		const current = this.t;
		this.t += this.step;
		return current;
	};

	get value(): number {
		return this.t;
	}
}

/**
 * Collects scheduled drains instead of running them on the real event loop.
 * `runAll` models an attentive observer; leaving tasks unrun models a stalled
 * one, letting the queue back up under a bounded, inspectable load.
 */
export class DeterministicScheduler {
	private tasks: Array<() => void> = [];

	readonly schedule = (fn: () => void): void => {
		this.tasks.push(fn);
	};

	get pending(): number {
		return this.tasks.length;
	}

	/** Run every currently-queued task (a task may enqueue more); returns the count run. */
	runAll(): number {
		let ran = 0;
		while (this.tasks.length > 0) {
			const next = this.tasks.shift();
			if (!next) break;
			next();
			ran++;
		}
		return ran;
	}

	/** Drop pending tasks without running them (models a permanently stalled observer). */
	discard(): void {
		this.tasks = [];
	}
}
