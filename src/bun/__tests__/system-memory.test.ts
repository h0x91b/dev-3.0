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
	it("reports Activity Monitor's used figure, excluding the file cache", () => {
		const result = parseMacMemory(MAC_VM_STAT, MAC_MEMSIZE, MAC_SWAP, "1")!;

		// (anonymous 4372930 - purgeable 198029 + wired 393186 + compressor 1422659) * 16384
		expect(result.used).toBe(5990746 * 16384);
		expect(result.used / GIB).toBeCloseTo(91.4, 1);
	});

	it("keeps the used/cached/free balance closed against total RAM", () => {
		const result = parseMacMemory(MAC_VM_STAT, MAC_MEMSIZE, MAC_SWAP, "1")!;

		// The strongest available check that `used` is defined the way Activity
		// Monitor defines it: used + cached files + free must reconstruct total.
		const free = 33747 * 16384; // Pages free
		const speculative = 42628 * 16384;
		const reconstructed = result.used + result.cached + free + speculative;
		expect(reconstructed / result.total).toBeCloseTo(1, 1);
	});

	it("treats reclaimable file cache as headroom, not as used", () => {
		const result = parseMacMemory(MAC_VM_STAT, MAC_MEMSIZE, MAC_SWAP, "1")!;

		// `top` calls this machine "894M unused". If headroom followed that, the
		// widget would be in permanent alarm while the OS reports normal pressure.
		expect(result.headroom).toBe(result.total - result.used);
		expect(result.headroom / GIB).toBeCloseTo(36.6, 1);
	});

	it("maps the OS pressure level rather than a percentage of its own", () => {
		expect(parseMacMemory(MAC_VM_STAT, MAC_MEMSIZE, MAC_SWAP, "1")!.osPressure).toBe("normal");
		expect(parseMacMemory(MAC_VM_STAT, MAC_MEMSIZE, MAC_SWAP, "2")!.osPressure).toBe("warn");
		expect(parseMacMemory(MAC_VM_STAT, MAC_MEMSIZE, MAC_SWAP, "4")!.osPressure).toBe("critical");
	});

	it("reports no OS verdict for an unknown pressure level", () => {
		expect(parseMacMemory(MAC_VM_STAT, MAC_MEMSIZE, MAC_SWAP, "7")!.osPressure).toBeNull();
		expect(parseMacMemory(MAC_VM_STAT, MAC_MEMSIZE, MAC_SWAP, "")!.osPressure).toBeNull();
	});

	it("exposes the cumulative swap-out counter", () => {
		expect(parseMacMemory(MAC_VM_STAT, MAC_MEMSIZE, MAC_SWAP, "1")!.swapOutCount).toBe(64);
	});

	it("falls back to active pages when Anonymous pages is missing", () => {
		const older = MAC_VM_STAT.replace(/^Anonymous pages:.*$/m, "");
		const result = parseMacMemory(older, MAC_MEMSIZE, MAC_SWAP, "1")!;

		// active 3239942 + wired 393186 + compressor 1422659
		expect(result.used).toBe(5055787 * 16384);
	});

	it("returns null on unusable input instead of inventing numbers", () => {
		expect(parseMacMemory("", MAC_MEMSIZE, MAC_SWAP, "1")).toBeNull();
		expect(parseMacMemory(MAC_VM_STAT, "", MAC_SWAP, "1")).toBeNull();
		expect(parseMacMemory(MAC_VM_STAT, "not-a-number", MAC_SWAP, "1")).toBeNull();
		expect(parseMacMemory("Mach Virtual Memory Statistics: (page size of 16384 bytes)", MAC_MEMSIZE, MAC_SWAP, "1")).toBeNull();
	});

	it("never reports used above total or negative headroom", () => {
		const absurd = MAC_VM_STAT.replace("Pages wired down:                        393186.", "Pages wired down:                    999999999.");
		const result = parseMacMemory(absurd, MAC_MEMSIZE, MAC_SWAP, "1")!;
		expect(result.used).toBe(result.total);
		expect(result.headroom).toBe(0);
	});
});

describe("parseSwapUsage", () => {
	it("scales the unit suffix to bytes", () => {
		expect(parseSwapUsage(MAC_SWAP)).toEqual({ total: 1024 * 1024 ** 2, used: 1024 ** 2 });
	});

	it("reads a machine with no swap configured as zero", () => {
		expect(parseSwapUsage("total = 0.00M  used = 0.00M  free = 0.00M")).toEqual({ total: 0, used: 0 });
	});

	it("returns zeros for junk rather than NaN", () => {
		expect(parseSwapUsage("")).toEqual({ total: 0, used: 0 });
		expect(parseSwapUsage("total = wat")).toEqual({ total: 0, used: 0 });
	});
});

describe("parseLinuxMemory", () => {
	it("defines used as total minus available", () => {
		const result = parseLinuxMemory(LINUX_MEMINFO, LINUX_PSI, LINUX_VMSTAT)!;
		expect(result.total).toBe(16384000 * 1024);
		expect(result.headroom).toBe(4194304 * 1024);
		expect(result.used).toBe(result.total - result.headroom);
	});

	it("derives swap in use from total minus free", () => {
		const result = parseLinuxMemory(LINUX_MEMINFO, LINUX_PSI, LINUX_VMSTAT)!;
		expect(result.swapTotal).toBe(2097152 * 1024);
		expect(result.swapUsed).toBe(1048576 * 1024);
	});

	it("classifies pressure from PSI full avg10", () => {
		const at = (fullAvg10: string) =>
			parseLinuxMemory(LINUX_MEMINFO, `some avg10=9 avg60=9 avg300=9 total=1\nfull avg10=${fullAvg10} avg60=0 avg300=0 total=1\n`, LINUX_VMSTAT)!.osPressure;

		expect(at("0.00")).toBe("normal");
		expect(at("0.49")).toBe("normal");
		expect(at("0.50")).toBe("warn");
		expect(at("4.99")).toBe("warn");
		expect(at("5.00")).toBe("critical");
	});

	it("reports no OS verdict when PSI is unavailable", () => {
		const result = parseLinuxMemory(LINUX_MEMINFO, "", LINUX_VMSTAT)!;
		expect(result.osPressure).toBeNull();
	});

	it("reads the cumulative pswpout counter", () => {
		expect(parseLinuxMemory(LINUX_MEMINFO, LINUX_PSI, LINUX_VMSTAT)!.swapOutCount).toBe(4242);
		expect(parseLinuxMemory(LINUX_MEMINFO, LINUX_PSI, "")!.swapOutCount).toBe(0);
	});

	it("returns null when meminfo is unusable", () => {
		expect(parseLinuxMemory("", LINUX_PSI, LINUX_VMSTAT)).toBeNull();
		expect(parseLinuxMemory("MemTotal: 16384000 kB", LINUX_PSI, LINUX_VMSTAT)).toBeNull();
	});
});

describe("classifyPressure", () => {
	it("trusts the OS verdict over any share of total", () => {
		// 3% headroom left, but the OS says it is fine — the OS wins, and the
		// result is not marked estimated.
		const result = classifyPressure(
			facts({ total: 100 * GIB, headroom: 3 * GIB, osPressure: "normal" }),
			{ swapping: false },
		);
		expect(result).toEqual({ pressure: "normal", estimated: false });
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

	it("escalates to warn while actively swapping even when the OS says normal", () => {
		const result = classifyPressure(facts({ osPressure: "normal" }), { swapping: true });
		expect(result.pressure).toBe("warn");
		expect(result.estimated).toBe(false);
	});

	it("does not downgrade critical because of the swap escalation", () => {
		expect(classifyPressure(facts({ osPressure: "critical" }), { swapping: true }).pressure).toBe("critical");
	});
});

describe("isSwapping", () => {
	it("is false on the first sample, with nothing to compare against", () => {
		expect(isSwapping(null, 64)).toBe(false);
	});

	it("is true only when the counter moved", () => {
		expect(isSwapping(64, 64)).toBe(false);
		expect(isSwapping(64, 65)).toBe(true);
	});

	it("ignores a counter reset (reboot) rather than reporting it as swapping", () => {
		expect(isSwapping(9000, 0)).toBe(false);
	});
});

describe("deriveDisplayName", () => {
	it("collapses helper processes onto the outermost app bundle", () => {
		const helper = deriveDisplayName(
			"/Applications/Google Chrome.app/Contents/Frameworks/Chromium Framework.framework/Versions/1/Helpers/Google Chrome Helper (Renderer).app/Contents/MacOS/Google Chrome Helper (Renderer) --type=renderer",
		);
		expect(helper.name).toBe("Google Chrome");
	});

	it("keeps a bundle path with spaces and dashes intact", () => {
		const vscode = deriveDisplayName(
			"/Applications/Visual Studio Code - Insiders.app/Contents/Frameworks/Code - Insiders Helper (Plugin).app/Contents/MacOS/Code - Insiders Helper (Plugin)",
		);
		expect(vscode.name).toBe("Visual Studio Code - Insiders");
		expect(vscode.path).toContain("Code - Insiders Helper (Plugin)");
	});

	it("uses the executable basename outside a bundle", () => {
		expect(deriveDisplayName("/usr/libexec/logd").name).toBe("logd");
		expect(deriveDisplayName("/usr/bin/node /srv/app/server.js --port 3000").name).toBe("node");
	});

	it("stops the program part at the first flag", () => {
		const result = deriveDisplayName("/usr/bin/node --max-old-space-size=8192 server.js");
		expect(result.name).toBe("node");
		expect(result.path).toBe("/usr/bin/node");
	});

	it("applies the alias table to unrecognisable daemon names", () => {
		expect(deriveDisplayName("/usr/local/bin/dockerd --host=fd://").name).toBe("Docker");
		expect(deriveDisplayName("/opt/homebrew/bin/com.docker.backend").name).toBe("Docker");
	});

	it("returns an empty name for an empty command line", () => {
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
	});

	it("shows the heaviest member's command line, not the first one seen", () => {
		const groups = groupConsumers(
			[
				{ pid: 1, rss: 1 * GIB, cmdline: chromeHelper(111) },
				{ pid: 2, rss: 8 * GIB, cmdline: chromeHelper(999) },
			],
			5,
		);
		expect(groups[0].cmdline).toContain("--id=999");
	});

	it("orders by summed memory, so a swarm of helpers outranks one fat process", () => {
		const groups = groupConsumers(
			[
				{ pid: 1, rss: 5 * GIB, cmdline: "/usr/bin/node server.js" },
				{ pid: 2, rss: 3 * GIB, cmdline: chromeHelper(1) },
				{ pid: 3, rss: 3 * GIB, cmdline: chromeHelper(2) },
			],
			5,
		);
		expect(groups.map((g) => g.name)).toEqual(["Google Chrome", "node"]);
	});

	it("keeps only the top N groups", () => {
		const processes = Array.from({ length: 12 }, (_, i) => ({
			pid: i + 1,
			rss: (i + 1) * GIB,
			cmdline: `/usr/bin/app${i}`,
		}));
		const groups = groupConsumers(processes, 5);
		expect(groups).toHaveLength(5);
		expect(groups[0].name).toBe("app11");
	});

	it("breaks an exact tie by name so the order does not flicker between polls", () => {
		const groups = groupConsumers(
			[
				{ pid: 1, rss: GIB, cmdline: "/usr/bin/zebra" },
				{ pid: 2, rss: GIB, cmdline: "/usr/bin/alpha" },
			],
			5,
		);
		expect(groups.map((g) => g.name)).toEqual(["alpha", "zebra"]);
	});

	it("caps the stored command line", () => {
		const long = `/usr/bin/node ${"x".repeat(2000)}`;
		const groups = groupConsumers([{ pid: 1, rss: GIB, cmdline: long }], 5);
		expect(groups[0].cmdline.length).toBe(CMDLINE_CAP);
	});

	it("skips processes with no command line rather than inventing a group", () => {
		const groups = groupConsumers(
			[
				{ pid: 1, rss: GIB, cmdline: "" },
				{ pid: 2, rss: GIB, cmdline: "/usr/bin/node" },
			],
			5,
		);
		expect(groups.map((g) => g.name)).toEqual(["node"]);
	});

	it("returns nothing for no input", () => {
		expect(groupConsumers([], 5)).toEqual([]);
	});
});

describe("median", () => {
	it("returns null with no active tasks, so the banner omits its forecast", () => {
		expect(median([])).toBeNull();
	});

	it("takes the middle value for an odd count", () => {
		expect(median([5, 1, 3])).toBe(3);
	});

	it("averages the two middle values for an even count", () => {
		expect(median([1, 2, 3, 4])).toBe(3);
	});

	it("does not mutate the caller's array", () => {
		const input = [3, 1, 2];
		median(input);
		expect(input).toEqual([3, 1, 2]);
	});
});
