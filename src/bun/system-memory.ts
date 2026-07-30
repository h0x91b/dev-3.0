import type { MemoryConsumerGroup, MemoryPressure } from "../shared/types";

/**
 * Pure derivation layer for system memory. NOTHING here does I/O — the probe
 * (`system-memory-probe.ts`) reads the platform, this module turns that text
 * into numbers. Every figure the UI shows is computed exactly once, here, so
 * the header pill, the breakdown popover and the launch banner can never
 * disagree with each other.
 *
 * Two separate concepts, deliberately never merged into one field:
 *   headroom — how many bytes are left. A quantity.
 *   pressure — the OS's own verdict on scarcity. A signal.
 * The suspend feature will decide on `pressure` while displaying `headroom`;
 * collapsing them into one "memory status" guarantees confusion later.
 */

/** Longest command line we keep. Diagnostic value dies well before this. */
export const CMDLINE_CAP = 400;

/** Platform-independent facts, before pressure classification. */
export interface MemoryFacts {
	total: number;
	/** Defined to match the OS's own activity monitor — see parseMacMemory. */
	used: number;
	headroom: number;
	/** Reclaimable file cache. Not "used", not "free" — shown for honesty. */
	cached: number;
	swapTotal: number;
	swapUsed: number;
	/** Cumulative swap-out counter. Only a delta across samples means anything. */
	swapOutCount: number;
	/** The OS's verdict, or null when the platform did not give us one. */
	osPressure: MemoryPressure | null;
}

// ── macOS ────────────────────────────────────────────────────────

/** `Pages active:  3239942.` → 3239942 */
function vmStatValue(vmStat: string, label: string): number | null {
	// The label is a literal from a fixed vm_stat key list, never user input.
	const m = vmStat.match(new RegExp(`^${label}:\\s+(\\d+)`, "m"));
	if (!m) return null;
	const n = Number(m[1]);
	return Number.isFinite(n) ? n : null;
}

/** `total = 1024.00M  used = 1.00M  free = 1023.00M` → bytes. */
export function parseSwapUsage(swapusage: string): { total: number; used: number } {
	const read = (key: string): number => {
		const m = swapusage.match(new RegExp(`${key}\\s*=\\s*([\\d.]+)([KMGT])?`));
		if (!m) return 0;
		const value = Number(m[1]);
		if (!Number.isFinite(value)) return 0;
		const scale = { K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 }[m[2] ?? ""] ?? 1;
		return Math.round(value * scale);
	};
	return { total: read("total"), used: read("used") };
}

/**
 * macOS: `vm_stat` + `sysctl hw.memsize vm.swapusage kern.memorystatus_vm_pressure_level`.
 *
 * `used` is App Memory + Wired + Compressed, i.e. Activity Monitor's "Memory
 * Used" — file cache and purgeable pages are excluded on purpose. Verified on a
 * 128 GB machine by checking the balance closes: used 91.4 + cached 34.5 +
 * free 1.25 ≈ 128 total (0.7% off, rounding + throttled pages).
 *
 * Do NOT "fix" this to match `top`, which reports 126 GB used / 894 MB unused on
 * that same machine because it counts the file cache as used. Matching `top`
 * would put the widget in permanent panic while the OS reports normal pressure —
 * exactly the cry-wolf failure the feature exists to avoid.
 */
export function parseMacMemory(
	vmStat: string,
	hwMemsize: string,
	swapusage: string,
	pressureLevel: string,
): MemoryFacts | null {
	const pageSize = Number(vmStat.match(/page size of (\d+) bytes/)?.[1]);
	const total = Number(hwMemsize.trim());
	if (!Number.isFinite(pageSize) || pageSize <= 0) return null;
	if (!Number.isFinite(total) || total <= 0) return null;

	const wired = vmStatValue(vmStat, "Pages wired down");
	const compressor = vmStatValue(vmStat, "Pages occupied by compressor");
	if (wired === null || compressor === null) return null;

	const anonymous = vmStatValue(vmStat, "Anonymous pages");
	const purgeable = vmStatValue(vmStat, "Pages purgeable");
	const active = vmStatValue(vmStat, "Pages active");

	// Anonymous includes inactive anonymous pages, so it beats `active` as the
	// app-memory proxy. Older vm_stat builds omit it — fall back to active,
	// which understates on a machine with a large inactive anonymous pool.
	let appPages: number;
	if (anonymous !== null) appPages = anonymous - (purgeable ?? 0);
	else if (active !== null) appPages = active;
	else return null;

	const used = Math.max(0, (appPages + wired + compressor) * pageSize);
	const fileBacked = vmStatValue(vmStat, "File-backed pages") ?? 0;

	const swap = parseSwapUsage(swapusage);
	const level = Number(pressureLevel.trim());

	return {
		total,
		used: Math.min(used, total),
		headroom: Math.max(0, total - Math.min(used, total)),
		cached: fileBacked * pageSize,
		swapTotal: swap.total,
		swapUsed: swap.used,
		swapOutCount: vmStatValue(vmStat, "Swapouts") ?? 0,
		// kern.memorystatus_vm_pressure_level: 1 normal, 2 warn, 4 critical.
		osPressure: level === 1 ? "normal" : level === 2 ? "warn" : level === 4 ? "critical" : null,
	};
}

// ── Linux ────────────────────────────────────────────────────────

/** `MemTotal:  16384000 kB` → bytes */
function meminfoValue(meminfo: string, label: string): number | null {
	const m = meminfo.match(new RegExp(`^${label}:\\s+(\\d+)\\s*kB`, "m"));
	if (!m) return null;
	const n = Number(m[1]);
	return Number.isFinite(n) ? n * 1024 : null;
}

/**
 * Linux: `/proc/meminfo` + `/proc/pressure/memory` + `/proc/vmstat`.
 *
 * `used = MemTotal - MemAvailable`, which the kernel already defines as "what
 * you can get without swapping" — the same intent as the macOS formula, and it
 * likewise excludes reclaimable cache.
 *
 * Pressure comes from pressure-stall information (`full avg10`): the share of
 * the last 10 seconds in which *every* task was stalled on memory. Absent on
 * kernels built without PSI and on some WSL kernels, hence `osPressure: null`
 * and the fallback in classifyPressure.
 */
export function parseLinuxMemory(meminfo: string, psiMemory: string, vmstat: string): MemoryFacts | null {
	const total = meminfoValue(meminfo, "MemTotal");
	const available = meminfoValue(meminfo, "MemAvailable");
	if (total === null || total <= 0 || available === null) return null;

	const headroom = Math.min(Math.max(0, available), total);
	const swapTotal = meminfoValue(meminfo, "SwapTotal") ?? 0;
	const swapFree = meminfoValue(meminfo, "SwapFree") ?? 0;

	const fullAvg10 = Number(psiMemory.match(/^full\s+avg10=([\d.]+)/m)?.[1]);
	let osPressure: MemoryPressure | null = null;
	if (Number.isFinite(fullAvg10)) {
		// Any sustained full stall is already felt by the user; 5% of wall clock
		// with every task blocked on memory is a machine in trouble.
		osPressure = fullAvg10 >= 5 ? "critical" : fullAvg10 >= 0.5 ? "warn" : "normal";
	}

	const pswpout = Number(vmstat.match(/^pswpout\s+(\d+)/m)?.[1]);

	return {
		total,
		used: total - headroom,
		headroom,
		cached: meminfoValue(meminfo, "Cached") ?? 0,
		swapTotal,
		swapUsed: Math.max(0, swapTotal - swapFree),
		swapOutCount: Number.isFinite(pswpout) ? pswpout : 0,
		osPressure,
	};
}

// ── Pressure classification ──────────────────────────────────────

/** Fallback-only thresholds, as a share of total. Never used when the OS speaks. */
const FALLBACK_CRITICAL_SHARE = 0.05;
const FALLBACK_WARN_SHARE = 0.15;

const PRESSURE_RANK: Record<MemoryPressure, number> = { normal: 0, warn: 1, critical: 2 };

/**
 * Turn facts into the signal that colours the widget.
 *
 * Prefers the OS verdict, because a percentage threshold that is right on an
 * 8 GB laptop is wrong on a 512 GB workstation. Percentages appear ONLY in the
 * fallback branch below, and `estimated` says so, so the primary path stays
 * free of invented constants.
 *
 * Active swapping escalates to at least `warn` even when the OS still says
 * normal — macOS holds "normal" well past the point the user feels the stall.
 */
export function classifyPressure(
	facts: MemoryFacts,
	opts: { swapping: boolean },
): { pressure: MemoryPressure; estimated: boolean } {
	let pressure: MemoryPressure;
	let estimated: boolean;

	if (facts.osPressure) {
		pressure = facts.osPressure;
		estimated = false;
	} else {
		const share = facts.total > 0 ? facts.headroom / facts.total : 1;
		pressure =
			share < FALLBACK_CRITICAL_SHARE ? "critical" : share < FALLBACK_WARN_SHARE ? "warn" : "normal";
		estimated = true;
	}

	if (opts.swapping && PRESSURE_RANK[pressure] < PRESSURE_RANK.warn) pressure = "warn";
	return { pressure, estimated };
}

/** Did the machine swap out between two samples? Counters are cumulative. */
export function isSwapping(previousSwapOutCount: number | null, current: number): boolean {
	if (previousSwapOutCount === null) return false;
	return current > previousSwapOutCount;
}

// ── Consumer grouping ────────────────────────────────────────────

/**
 * Multi-process apps whose executable basename is unrecognisable. Keep this
 * table SMALL — the `.app` bundle rule below already handles most macOS apps,
 * so an entry here has to earn itself.
 */
const NAME_ALIASES: Record<string, string> = {
	"com.docker.backend": "Docker",
	"com.docker.build": "Docker",
	"com.docker.dev-environments": "Docker",
	dockerd: "Docker",
	"docker-proxy": "Docker",
	"containerd-shim-runc-v2": "Docker",
	containerd: "Docker",
	chrome: "Google Chrome",
	chromium: "Chromium",
	"chrome_crashpad_handler": "Google Chrome",
	firefox: "Firefox",
	"firefox-bin": "Firefox",
};

export interface RawConsumer {
	pid: number;
	rss: number;
	cmdline: string;
}

/**
 * Derive a grouping name and an executable path from a command line.
 *
 * The macOS bundle check comes FIRST, before any attempt to cut the line, because
 * a bundle path legitimately contains both spaces and " - "
 * ("/Applications/Visual Studio Code - Insiders.app/…"). Splitting on whitespace
 * or on " -" first truncates that to "Visual Studio Code" and silently splits one
 * app into two rows.
 *
 * Taking the OUTERMOST `.app` is what collapses eighty helper processes into one
 * honest "Google Chrome" row instead of five identical unhelpful ones. The known
 * cost: a non-bundled process whose *arguments* mention a bundle (`open
 * /Applications/Foo.app/`) is named after that bundle. Such processes hold
 * negligible memory, so they never reach a top-N row.
 */
export function deriveDisplayName(cmdline: string): { name: string; path: string } {
	const trimmed = cmdline.trim();
	if (!trimmed) return { name: "", path: "" };

	const bundle = trimmed.match(/([^/]+)\.app\//);
	if (bundle) {
		// " --" is a reliable flag marker; a bare " -" appears inside real bundle names.
		const flagAt = trimmed.indexOf(" --");
		return { name: bundle[1], path: (flagAt === -1 ? trimmed : trimmed.slice(0, flagAt)).trim() };
	}

	// Outside a bundle the executable is the first whitespace token — arguments
	// may themselves be paths ("node /srv/app/server.js"), so the last path
	// component of the whole line is the wrong answer.
	const program = trimmed.split(/\s+/)[0];
	const base = program.split("/").pop() || program;
	return { name: NAME_ALIASES[base] ?? base, path: program };
}

/**
 * Group processes by application and return the heaviest `limit` groups.
 *
 * Grouping is by display name, not by process-tree root: detached helpers and
 * daemons reparent to init, which defeats tree-based grouping entirely.
 */
export function groupConsumers(processes: RawConsumer[], limit: number): MemoryConsumerGroup[] {
	// Track the heaviest member's rss alongside the group so a later, lighter
	// process cannot overwrite the identity we show.
	const groups = new Map<string, MemoryConsumerGroup & { peakRss: number }>();

	for (const proc of processes) {
		const { name, path } = deriveDisplayName(proc.cmdline);
		if (!name) continue;

		const existing = groups.get(name);
		if (!existing) {
			groups.set(name, {
				name,
				rss: proc.rss,
				processCount: 1,
				path,
				cmdline: proc.cmdline.slice(0, CMDLINE_CAP),
				peakRss: proc.rss,
			});
			continue;
		}

		existing.rss += proc.rss;
		existing.processCount += 1;
		// The heaviest member is the one worth inspecting, so it owns the
		// displayed path and command line.
		if (proc.rss > existing.peakRss) {
			existing.peakRss = proc.rss;
			existing.path = path;
			existing.cmdline = proc.cmdline.slice(0, CMDLINE_CAP);
		}
	}

	return [...groups.values()]
		.map(({ peakRss: _peakRss, ...group }) => group)
		.sort((a, b) => b.rss - a.rss || a.name.localeCompare(b.name))
		.slice(0, limit);
}

/** Median, or null for an empty set — never a guessed stand-in. */
export function median(values: number[]): number | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}
