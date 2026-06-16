// Minimal FIFO semaphore for bounding concurrent async work.
//
// Used to cap how many heavy git-status runs (each spawning `git fetch` + `gh`
// + a fistful of local git commands) execute at once. A burst of task panels
// becoming visible together must not explode into dozens of simultaneous git
// processes — the queue smooths it into a steady trickle.

export class Semaphore {
	private available: number;
	private readonly queue: Array<() => void> = [];

	constructor(max: number) {
		this.available = Math.max(1, Math.floor(max));
	}

	private acquire(): Promise<void> {
		if (this.available > 0) {
			this.available -= 1;
			return Promise.resolve();
		}
		return new Promise<void>((resolve) => this.queue.push(resolve));
	}

	private release(): void {
		const next = this.queue.shift();
		if (next) {
			// Hand the still-taken slot directly to the next waiter.
			next();
		} else {
			this.available += 1;
		}
	}

	/** Run `fn` once a slot is free, always releasing the slot afterwards. */
	async run<T>(fn: () => Promise<T>): Promise<T> {
		await this.acquire();
		try {
			return await fn();
		} finally {
			this.release();
		}
	}

	/** Number of callers currently waiting for a slot (introspection/tests). */
	get waiting(): number {
		return this.queue.length;
	}

	/** Number of free slots right now (introspection/tests). */
	get free(): number {
		return this.available;
	}
}
