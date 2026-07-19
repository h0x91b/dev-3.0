/**
 * Incremental parser for `git clone --progress` stderr output.
 *
 * Git renders progress by rewriting the current line in place with `\r`
 * ("Receiving objects:  42% ...") and committing finished phases with `\n`.
 * The parser mirrors what a terminal would display: `\n` commits the live
 * line, `\r` marks it so the next character starts overwriting it.
 */

/** Committed lines kept in memory — enough for any error tail we report. */
const MAX_COMMITTED_LINES = 50;

export class CloneProgressParser {
	private committed: string[] = [];
	private live = "";
	private overwritePending = false;

	feed(chunk: string): void {
		for (const ch of chunk) {
			if (ch === "\n") {
				this.commitLive();
			} else if (ch === "\r") {
				this.overwritePending = true;
			} else {
				if (this.overwritePending) {
					this.live = "";
					this.overwritePending = false;
				}
				this.live += ch;
			}
		}
	}

	private commitLive(): void {
		this.committed.push(this.live);
		if (this.committed.length > MAX_COMMITTED_LINES) this.committed.shift();
		this.live = "";
		this.overwritePending = false;
	}

	/**
	 * Last `max` non-empty lines as a terminal would currently show them,
	 * including the in-progress (`\r`-rewritten) line.
	 */
	lines(max: number): string[] {
		const all = this.live ? [...this.committed, this.live] : [...this.committed];
		return all.map((l) => l.trimEnd()).filter(Boolean).slice(-max);
	}
}
