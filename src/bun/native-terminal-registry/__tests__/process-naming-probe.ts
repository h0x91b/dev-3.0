/**
 * Child half of the argv0 visibility proof (seq 1383).
 *
 * Spawned with an overridden argv0, it reports what IT sees of its own identity
 * and then idles until killed, so the parent can ask the operating system what
 * the process looks like from outside.
 *
 * `DEV3_NAMING_PROBE_TITLE` opts into a `process.title` write. It is a SEPARATE
 * run on purpose: on macOS that write overwrites the argv area in place, so a
 * probe that always set the title would destroy the very argv0 under test.
 */

const before = process.title;
const requestedTitle = process.env.DEV3_NAMING_PROBE_TITLE;
let titleSetThrew = false;
if (requestedTitle) {
	try {
		process.title = requestedTitle;
	} catch {
		titleSetThrew = true;
	}
}

process.stdout.write(
	`${JSON.stringify({
		argv: process.argv,
		execPath: process.execPath,
		platform: process.platform,
		title: { requested: requestedTitle ?? null, before, after: process.title, setThrew: titleSetThrew },
	})}\n`,
);

// Idle without holding stdin: the parent inspects the live process, then kills it.
setInterval(() => {}, 60_000);
