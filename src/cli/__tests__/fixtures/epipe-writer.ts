/**
 * Test fixture for the broken-pipe guard (see ../epipe.test.ts).
 *
 * Writes far more to stdout than a pipe buffer can hold, so once the reader
 * closes its end a subsequent write hits EPIPE. Pass `--guard` to install the
 * CLI's EPIPE guard first (expected: clean exit 0, no stack trace); omit it to
 * observe Bun's raw broken-pipe crash (the control case).
 */
import { installEpipeGuard } from "../../epipe";

if (process.argv.includes("--guard")) {
	installEpipeGuard();
}

const line = `${"x".repeat(120)}\n`;
// ~36 MB total — far past any pipe buffer, so a flush after the reader closes
// is guaranteed to hit EPIPE, while staying small enough to run fast.
for (let i = 0; i < 300_000; i++) {
	process.stdout.write(line);
}
