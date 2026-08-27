/**
 * Coarse "what kind of install is this" facts for analytics, and the pure
 * bucketing that keeps them coarse.
 *
 * EVERY NUMBER HERE IS BUCKETED BEFORE IT LEAVES THE MACHINE, and that is the
 * whole design. A raw project count, a raw task count or a raw install age is a
 * near-unique fingerprint; a bucket answers "one repo or a studio of twenty"
 * without ever describing one person. GA4 also collapses a dimension's long tail
 * into "(other)" past its cardinality limit, so an unbucketed count would be
 * useless as well as leaky.
 */

/** Coarse install facts a renderer reports as GA4 user properties. */
export interface TelemetryProfile {
	/** `arm64`, `x64`, or `x64-rosetta` — an Intel build translated on Apple Silicon. */
	cpuArch: string;
	/** Major OS version (`15`, `11`, `6.8`), or `""` when it cannot be derived. */
	osVersion: string;
	/** How the running binary was installed (`brew-formula`, `app-bundle`, `source`, …). */
	installType: string;
	/** Backend NEW tasks get on this machine: `tmux` or `native`. */
	terminalBackend: string;
	/** The agent preset new tasks launch with, by name (`claude`, `codex`, …). */
	defaultAgent: string;
	projectCountBucket: string;
	taskCountBucket: string;
	/** Empty when the install date could not be established. */
	installAgeBucket: string;
}

/** How many projects the user keeps: one repo, or a studio's worth. */
export function projectCountBucket(count: number): string {
	if (count <= 0) return "0";
	if (count === 1) return "1";
	if (count <= 5) return "2-5";
	if (count <= 15) return "6-15";
	if (count <= 30) return "16-30";
	return "31+";
}

/** Depth of use. The top bucket is deliberately wide — heavy boards run into thousands. */
export function taskCountBucket(count: number): string {
	if (count <= 0) return "0";
	if (count <= 10) return "1-10";
	if (count <= 50) return "11-50";
	if (count <= 200) return "51-200";
	if (count <= 1000) return "201-1000";
	return "1001+";
}

/** Day 91 is where weeks stop and months take over (a quarter). */
const MONTHS_START_DAY = 91;
/** Nominal month length for the coarse tail; exactness past a quarter buys nothing. */
const DAYS_PER_MONTH = 30;

const pad2 = (n: number): string => String(n).padStart(2, "0");

/**
 * Age of the install as a fixed grid: days through the first week, weeks to a
 * quarter, then months forever.
 *
 * `day-0` IS THE POINT OF THE WHOLE PROPERTY. Isolating the day someone installed
 * dev3 — and `day-1` next to it — is what makes first-day retention readable at a
 * glance; every coarser tail exists only so the fine head stays uncluttered.
 *
 * Weeks and months are zero-padded so a report sorted by the dimension name keeps
 * chronological order inside each family (`week-02` before `week-10`). Ordering
 * ACROSS the three families is not alphabetical and never will be — sort those by
 * a metric, not by the label.
 */
export function installAgeBucket(days: number): string {
	const d = Math.max(0, Math.floor(days));
	if (d <= 2) return `day-${d}`;
	if (d <= 6) return "day-3-6";
	if (d < MONTHS_START_DAY) return `week-${pad2(Math.floor(d / 7))}`;
	return `month-${pad2(Math.floor(d / DAYS_PER_MONTH))}`;
}

/** Whole days between two epoch-ms timestamps, floored at 0. */
export function daysSince(installedAtMs: number, nowMs: number): number {
	return Math.max(0, Math.floor((nowMs - installedAtMs) / 86_400_000));
}

/**
 * CPU architecture as reported, with a translated Intel build called out.
 *
 * The User-Agent cannot answer this: WebKit freezes the platform token at
 * `Intel Mac OS X 10_15_7` on every Mac, Apple Silicon included, and Rosetta is
 * invisible in it entirely.
 */
export function cpuArchLabel(arch: string, rosetta: boolean): string {
	return rosetta ? `${arch}-rosetta` : arch;
}

/** Windows 11 kept the `10.0.x` release string; the build number is what moved. */
const WINDOWS_11_MIN_BUILD = 22000;

/**
 * The OS version, from the KERNEL release rather than the User-Agent.
 *
 * WebKit reports `Mac OS X 10_15_7` on every Mac ever made — Apple froze it — so a
 * UA-derived version is not merely imprecise, it is the same wrong number for the
 * whole macOS population.
 *
 * Major version only. Darwin's minor does not track macOS's (Darwin 24.6 is macOS
 * 15.7), and a patch-level version would be a high-cardinality dimension answering
 * a question nobody asks.
 */
export function osVersionFromKernel(platform: string, release: string): string {
	const parts = release.split(".").map((n) => Number.parseInt(n, 10));
	if (parts.some((n) => !Number.isFinite(n))) return "";
	if (platform === "darwin") {
		// Darwin 20 = macOS 11, and it has tracked +9 ever since.
		return parts[0] >= 20 ? String(parts[0] - 9) : "";
	}
	if (platform === "win32") {
		return (parts[2] ?? 0) >= WINDOWS_11_MIN_BUILD ? "11" : String(parts[0]);
	}
	return parts.length >= 2 ? `${parts[0]}.${parts[1]}` : String(parts[0]);
}
