import { describe, it, expect } from "vitest";
import {
	CMDLINE_CAP,
	classifyPressure,
	deriveDisplayName,
	groupConsumers,
	isSwapping,
	median,
	parseLinuxMemory,
	parseMacMemory,
	parseSwapUsage,
	type MemoryFacts,
} from "../system-memory";

/**
 * Real `vm_stat` output from a 128 GB Apple Silicon machine (16 KiB pages), kept
 * verbatim. The whole point of the used-memory formula is matching what the OS
 * itself reports, so the fixture must not be a tidied-up invention.
 */
const MAC_VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               33747.
Pages active:                           3239942.
Pages inactive:                         3196138.
Pages speculative:                        42628.
Pages throttled:                              0.
Pages wired down:                        393186.
Pages purgeable:                         198029.
"Translation faults":               41983929819.
Pages copy-on-write:                 1076463199.
Pages zero filled:                   7734427217.
Pages reactivated:                     51193909.
Pages purged:                          53580406.
File-backed pages:                      2105778.
Anonymous pages:                        4372930.
Pages stored in compressor:             2726921.
Pages occupied by compressor:           1422659.
Decompressions:                        14714868.
Compressions:                          28800659.
Pageins:                              166343913.
Pageouts:                                319613.
Swapins:                                      0.
Swapouts:                                    64.
`;

const MAC_MEMSIZE = "137438953472\n";
const MAC_SWAP = "total = 1024.00M  used = 1.00M  free = 1023.00M  (encrypted)\n";
const GIB = 1024 ** 3;

const LINUX_MEMINFO = `MemTotal:       16384000 kB
MemFree:          524288 kB
MemAvailable:    4194304 kB
Buffers:          131072 kB
Cached:          6291456 kB
SwapTotal:       2097152 kB
SwapFree:        1048576 kB
`;

const LINUX_PSI = `some avg10=1.23 avg60=0.80 avg300=0.20 total=123456
full avg10=0.10 avg60=0.05 avg300=0.01 total=54321
`;

const LINUX_VMSTAT = `pgfault 123456\npswpin 10\npswpout 4242\n`;

function facts(overrides?: Partial<MemoryFacts>): MemoryFacts {
	return {
		total: 16 * GIB,
		used: 8 * GIB,
		headroom: 8 * GIB,
		cached: 2 * GIB,
		swapTotal: 2 * GIB,
		swapUsed: 0,
		swapOutCount: 0,
		osPressure: "normal",
		...overrides,
	};
}

describe("parseMacMemory", () => {
	it("reports Activity Monitor's used figure, cache as headroom, and the swap-out counter", () => {
		const result = parseMacMemory(MAC_VM_STAT, MAC_MEMSIZE, MAC_SWAP, "1")!;

		// (anonymous 4372930 - purgeable 198029 + wired 393186 + compressor 1422659) * 16384
		expect(result.used).toBe(5990746 * 16384);
		expect(result.used / GIB).toBeCloseTo(91.4, 1);
		expect(result.swapOutCount).toBe(64);

		// The strongest available check that `used` is defined the way Activity
		// Monitor defines it: used + cached files + free must reconstruct total.
		const free = 33747 * 16384; // Pages free
		const speculative = 42628 * 16384;
		const reconstructed = result.used + result.cached + free + speculative;
		expect(reconstructed / result.total).toBeCloseTo(1, 1);

		// `top` calls this machine "894M unused". If headroom followed that, the
		// widget would be in permanent alarm while the OS reports normal pressure.
		expect(result.headroom).toBe(result.total - result.used);
		expect(result.headroom / GIB).toBeCloseTo(36.6, 1);
	});

	it("maps the OS pressure level rather than a percentage of its own", () => {
		expect(parseMacMemory(MAC_VM_STAT, MAC_MEMSIZE, MAC_SWAP, "1")!.osPressure).toBe("normal");
		expect(parseMacMemory(MAC_VM_STAT, MAC_MEMSIZE, MAC_SWAP, "2")!.osPressure).toBe("warn");
		expect(parseMacMemory(MAC_VM_STAT, MAC_MEMSIZE, MAC_SWAP, "4")!.osPressure).toBe("critical");
		// An unknown level is no verdict at all.
		expect(parseMacMemory(MAC_VM_STAT, MAC_MEMSIZE, MAC_SWAP, "7")!.osPressure).toBeNull();
		expect(parseMacMemory(MAC_VM_STAT, MAC_MEMSIZE, MAC_SWAP, "")!.osPressure).toBeNull();
	});

	it("falls back to active pages when Anonymous pages is missing, and clamps used to total", () => {
		const older = MAC_VM_STAT.replace(/^Anonymous pages:.*$/m, "");
		const result = parseMacMemory(older, MAC_MEMSIZE, MAC_SWAP, "1")!;

		// active 3239942 + wired 393186 + compressor 1422659
		expect(result.used).toBe(5055787 * 16384);

		// Never used above total, never negative headroom.
		const absurd = MAC_VM_STAT.replace("Pages wired down:                        393186.", "Pages wired down:                    999999999.");
		const clamped = parseMacMemory(absurd, MAC_MEMSIZE, MAC_SWAP, "1")!;
		expect(clamped.used).toBe(clamped.total);
		expect(clamped.headroom).toBe(0);
	});

	it("returns null on unusable input instead of inventing numbers", () => {
		expect(parseMacMemory("", MAC_MEMSIZE, MAC_SWAP, "1")).toBeNull();
		expect(parseMacMemory(MAC_VM_STAT, "", MAC_SWAP, "1")).toBeNull();
		expect(parseMacMemory(MAC_VM_STAT, "not-a-number", MAC_SWAP, "1")).toBeNull();
		expect(parseMacMemory("Mach Virtual Memory Statistics: (page size of 16384 bytes)", MAC_MEMSIZE, MAC_SWAP, "1")).toBeNull();
	});
});

describe("parseSwapUsage", () => {
	it("scales the unit suffix to bytes, and reads no swap or junk as zeros (never NaN)", () => {
		expect(parseSwapUsage(MAC_SWAP)).toEqual({ total: 1024 * 1024 ** 2, used: 1024 ** 2 });
		expect(parseSwapUsage("total = 0.00M  used = 0.00M  free = 0.00M")).toEqual({ total: 0, used: 0 });
		expect(parseSwapUsage("")).toEqual({ total: 0, used: 0 });
		expect(parseSwapUsage("total = wat")).toEqual({ total: 0, used: 0 });
	});
});

describe("parseLinuxMemory", () => {
	it("defines used as total minus available, swap used as total minus free, and reads pswpout", () => {
		const result = parseLinuxMemory(LINUX_MEMINFO, LINUX_PSI, LINUX_VMSTAT)!;
		expect(result.total).toBe(16384000 * 1024);
		expect(result.headroom).toBe(4194304 * 1024);
		expect(result.used).toBe(result.total - result.headroom);
		expect(result.swapTotal).toBe(2097152 * 1024);
		expect(result.swapUsed).toBe(1048576 * 1024);
		expect(result.swapOutCount).toBe(4242);
		expect(parseLinuxMemory(LINUX_MEMINFO, LINUX_PSI, "")!.swapOutCount).toBe(0);
		// Unusable meminfo → null.
		expect(parseLinuxMemory("", LINUX_PSI, LINUX_VMSTAT)).toBeNull();
		expect(parseLinuxMemory("MemTotal: 16384000 kB", LINUX_PSI, LINUX_VMSTAT)).toBeNull();
	});

	it("classifies pressure from PSI full avg10", () => {
		const at = (fullAvg10: string) =>
			parseLinuxMemory(LINUX_MEMINFO, `some avg10=9 avg60=9 avg300=9 total=1\nfull avg10=${fullAvg10} avg60=0 avg300=0 total=1\n`, LINUX_VMSTAT)!.osPressure;

		expect(at("0.00")).toBe("normal");
		expect(at("0.49")).toBe("normal");
		expect(at("0.50")).toBe("warn");
		expect(at("4.99")).toBe("warn");
		expect(at("5.00")).toBe("critical");
		// No PSI → no OS verdict.
		expect(parseLinuxMemory(LINUX_MEMINFO, "", LINUX_VMSTAT)!.osPressure).toBeNull();
	});
});

describe("classifyPressure", () => {
	it("trusts the OS verdict over any share of total, escalating only for active swapping", () => {
		// 3% headroom left, but the OS says it is fine — the OS wins, and the
		// result is not marked estimated.
		const result = classifyPressure(
			facts({ total: 100 * GIB, headroom: 3 * GIB, osPressure: "normal" }),
			{ swapping: false },
		);
		expect(result).toEqual({ pressure: "normal", estimated: false });

		// Active swapping escalates an OS "normal" to warn (still not estimated), never downgrades critical.
		expect(classifyPressure(facts({ osPressure: "normal" }), { swapping: true })).toEqual({ pressure: "warn", estimated: false });
		expect(classifyPressure(facts({ osPressure: "critical" }), { swapping: true }).pressure).toBe("critical");
	});

	it("falls back to a share of total when the OS gives no verdict", () => {
		const at = (headroomGib: number) =>
			classifyPressure(facts({ total: 100 * GIB, headroom: headroomGib * GIB, osPressure: null }), {
				swapping: false,
			});

		expect(at(50)).toEqual({ pressure: "normal", estimated: true });
		expect(at(14)).toEqual({ pressure: "warn", estimated: true });
		expect(at(4)).toEqual({ pressure: "critical", estimated: true });
	});
});

describe("isSwapping", () => {
	it("is true only when the counter moved — not on the first sample, nor on a reset", () => {
		expect(isSwapping(null, 64)).toBe(false);
		expect(isSwapping(64, 64)).toBe(false);
		expect(isSwapping(64, 65)).toBe(true);
		expect(isSwapping(9000, 0)).toBe(false); // reboot
	});
});

describe("deriveDisplayName", () => {
	it("collapses helper processes onto the outermost app bundle", () => {
		const helper = deriveDisplayName(
			"/Applications/Google Chrome.app/Contents/Frameworks/Chromium Framework.framework/Versions/1/Helpers/Google Chrome Helper (Renderer).app/Contents/MacOS/Google Chrome Helper (Renderer) --type=renderer",
		);
		expect(helper.name).toBe("Google Chrome");

		// A bundle path with spaces and dashes stays intact.
		const vscode = deriveDisplayName(
			"/Applications/Visual Studio Code - Insiders.app/Contents/Frameworks/Code - Insiders Helper (Plugin).app/Contents/MacOS/Code - Insiders Helper (Plugin)",
		);
		expect(vscode.name).toBe("Visual Studio Code - Insiders");
		expect(vscode.path).toContain("Code - Insiders Helper (Plugin)");
	});

	it("uses the executable basename outside a bundle", () => {
		expect(deriveDisplayName("/usr/libexec/logd").name).toBe("logd");
		expect(deriveDisplayName("/usr/bin/node /srv/app/server.js --port 3000").name).toBe("node");
		// The program part stops at the first flag.
		const result = deriveDisplayName("/usr/bin/node --max-old-space-size=8192 server.js");
		expect(result.name).toBe("node");
		expect(result.path).toBe("/usr/bin/node");
	});

	it("applies the alias table to unrecognisable daemon names, and returns an empty name for an empty line", () => {
		expect(deriveDisplayName("/usr/local/bin/dockerd --host=fd://").name).toBe("Docker");
		expect(deriveDisplayName("/opt/homebrew/bin/com.docker.backend").name).toBe("Docker");
		expect(deriveDisplayName("")).toEqual({ name: "", path: "" });
		expect(deriveDisplayName("   ")).toEqual({ name: "", path: "" });
	});
});

describe("groupConsumers", () => {
	const chromeHelper = (n: number) =>
		`/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Helper.app/Contents/MacOS/Google Chrome Helper --id=${n}`;

	it("sums a multi-process app into one row and counts its processes", () => {
		const groups = groupConsumers(
			[
				{ pid: 1, rss: 3 * GIB, cmdline: chromeHelper(1) },
				{ pid: 2, rss: 4 * GIB, cmdline: chromeHelper(2) },
				{ pid: 3, rss: 2 * GIB, cmdline: chromeHelper(3) },
			],
			5,
		);

		expect(groups).toHaveLength(1);
		expect(groups[0].name).toBe("Google Chrome");
		expect(groups[0].rss).toBe(9 * GIB);
		expect(groups[0].processCount).toBe(3);
		// The heaviest member's command line is shown, not the first one seen.
		expect(groups[0].cmdline).toContain("--id=2");
	});

	it("orders by summed memory (ties by name) and keeps only the top N", () => {
		const groups = groupConsumers(
			[
				{ pid: 1, rss: 5 * GIB, cmdline: "/usr/bin/node server.js" },
				{ pid: 2, rss: 3 * GIB, cmdline: chromeHelper(1) },
				{ pid: 3, rss: 3 * GIB, cmdline: chromeHelper(2) },
			],
			5,
		);
		expect(groups.map((g) => g.name)).toEqual(["Google Chrome", "node"]);

		// An exact tie breaks by name so the order does not flicker between polls.
		const tied = groupConsumers(
			[
				{ pid: 1, rss: GIB, cmdline: "/usr/bin/zebra" },
				{ pid: 2, rss: GIB, cmdline: "/usr/bin/alpha" },
			],
			5,
		);
		expect(tied.map((g) => g.name)).toEqual(["alpha", "zebra"]);

		// Only the top N groups are kept.
		const processes = Array.from({ length: 12 }, (_, i) => ({
			pid: i + 1,
			rss: (i + 1) * GIB,
			cmdline: `/usr/bin/app${i}`,
		}));
		const top = groupConsumers(processes, 5);
		expect(top).toHaveLength(5);
		expect(top[0].name).toBe("app11");
	});

	it("caps the stored command line and skips processes with none rather than inventing a group", () => {
		const long = `/usr/bin/node ${"x".repeat(2000)}`;
		expect(groupConsumers([{ pid: 1, rss: GIB, cmdline: long }], 5)[0].cmdline.length).toBe(CMDLINE_CAP);
		const groups = groupConsumers(
			[
				{ pid: 1, rss: GIB, cmdline: "" },
				{ pid: 2, rss: GIB, cmdline: "/usr/bin/node" },
			],
			5,
		);
		expect(groups.map((g) => g.name)).toEqual(["node"]);
		expect(groupConsumers([], 5)).toEqual([]);
	});
});

describe("median", () => {
	it("is null when empty, the middle for odd counts, the mean of the middle two for even, and never mutates", () => {
		expect(median([])).toBeNull(); // no active tasks → the banner omits its forecast
		const odd = [5, 1, 3];
		expect(median(odd)).toBe(3);
		expect(odd).toEqual([5, 1, 3]);
		expect(median([1, 2, 3, 4])).toBe(3);
	});
});
