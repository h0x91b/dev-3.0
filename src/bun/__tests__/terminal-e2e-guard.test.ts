import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	AMBIGUOUS_LOCAL_WARNING,
	isAmbiguousProcess,
	isClean,
	isOurProcess,
	isOurTempEntry,
	parseProcessTable,
	processKeys,
	renderEvidence,
	renderRuntimeTable,
	selectScripts,
	looksLikeSuite,
	ownsProcess,
	hasSurvivors,
	shouldStop,
	survivors,
	TERMINAL_E2E_SCRIPTS,
	verdictOf,
	type E2eResult,
} from "../terminal-e2e-guard";

const clean = (over: Partial<E2eResult> = {}): E2eResult => ({
	name: "tmux-guarded-send-e2e",
	tier: "fast",
	ms: 6_400,
	ok: true,
	orphans: [],
	ambiguous: [],
	tempLeaks: [],
	...over,
});

describe("the gated script list", () => {
	it("names only scripts that package.json actually defines", () => {
		const repoRoot = join(import.meta.dirname, "..", "..", "..");
		const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
			scripts: Record<string, string>;
		};
		for (const script of TERMINAL_E2E_SCRIPTS) {
			expect(pkg.scripts[`test:${script.name}`], `test:${script.name} is gated but not defined`).toBeTypeOf("string");
		}
	});

	it("covers every live terminal e2e script the repo has", () => {
		// A new `*.bun-e2e.ts` gate script that never lands here would be invisible in CI,
		// which is exactly the state this gate replaced.
		expect(TERMINAL_E2E_SCRIPTS.map((script) => script.name)).toEqual([
			"tmux-guarded-send-e2e",
			"pane-input-owner-e2e",
			"pane-input-native-e2e",
			"native-registry-e2e",
			"native-owner-routing-e2e",
			"native-multipane-e2e",
			"native-message-e2e",
		]);
	});

	it("runs the whole set unless a tier is asked for", () => {
		expect(selectScripts("all")).toHaveLength(TERMINAL_E2E_SCRIPTS.length);
		expect(selectScripts("fast").length).toBeGreaterThan(0);
		expect(selectScripts("fast").every((script) => script.tier === "fast")).toBe(true);
	});
});

describe("parsing ps output", () => {
	it("reads pid and full command from `ps ax -o pid=,command=`", () => {
		const entries = parseProcessTable(
			["  501 /usr/bin/tmux: server (/tmp/tmux-0/dev3-live-guarded-42)", "1234 bun run test:native-registry-e2e"].join(
				"\n",
			),
		);
		expect(entries).toEqual([
			{ pid: 501, command: "/usr/bin/tmux: server (/tmp/tmux-0/dev3-live-guarded-42)" },
			{ pid: 1234, command: "bun run test:native-registry-e2e" },
		]);
	});

	it("drops lines it cannot parse instead of guessing", () => {
		expect(parseProcessTable("PID COMMAND\n\n   \n")).toEqual([]);
	});
});

const MINE = { repoRoot: "/wt/d006684c/worktree" };
const SIBLING_ROOT = "/wt/671f7477/worktree";

describe("recognising the suite", () => {
	it("claims a stranded native host, tmux server, and throwaway-rooted shell", () => {
		expect(looksLikeSuite("tmux: server (/private/tmp/tmux-501/dev3-live-guarded-9911)")).toBe(true);
		expect(looksLikeSuite("cat > /var/folders/x/dev3-guarded-send-abc/mine.txt")).toBe(true);
		expect(looksLikeSuite("/bin/zsh -i -c cd /tmp/d3or-xyz")).toBe(true);
		expect(looksLikeSuite("bun --role=owner dev3-task-00000000-0000-4000-8000-00000000e2e5-pane-1")).toBe(true);
		expect(looksLikeSuite("dev3-terminal-host h.js session-host owner-routing-91ab")).toBe(true);
		expect(looksLikeSuite("dev3-terminal-host h.js session-host mpe2e-pane-1")).toBe(true);
	});

	it("does not claim unrelated processes", () => {
		expect(looksLikeSuite("/usr/bin/ssh-agent -l")).toBe(false);
		expect(looksLikeSuite("tmux: server (/private/tmp/tmux-501/default)")).toBe(false);
		expect(looksLikeSuite("node /home/runner/work/dev-3.0/dev-3.0/node_modules/.bin/vitest")).toBe(false);
	});

	it("recognises the temp roots the scripts create, and nothing else", () => {
		expect(isOurTempEntry("dev3-multipane-e2e-Ab12")).toBe(true);
		expect(isOurTempEntry("d3or-Ab12")).toBe(true);
		expect(isOurTempEntry("com.apple.launchd.abc")).toBe(false);
	});
});

// Looking like the suite is NOT enough, and this is the false positive that made a clean
// local run go red once: a SIBLING WORKTREE was running the same scripts, so its processes
// carried the same hard-coded session ids and were "new" against our baseline.
describe("attributing a survivor to this run", () => {
	it("owns a process only when its argv names this checkout", () => {
		expect(ownsProcess(`bun ${MINE.repoRoot}/src/bun/__tests__/x.ts`, MINE)).toBe(true);
		expect(ownsProcess(`bun ${SIBLING_ROOT}/src/bun/__tests__/x.ts`, MINE)).toBe(false);
	});

	it("does not claim a sibling worktree's identical e2e process", () => {
		const sibling = `bun ${SIBLING_ROOT}/src/bun/native-terminal-registry/cli.ts __host dev3-task-00000000-0000-4000-8000-000000000001-pane-1`;
		expect(looksLikeSuite(sibling), "it does look like the suite — that is the trap").toBe(true);
		expect(isOurProcess(sibling, MINE)).toBe(false);
		expect(isAmbiguousProcess(sibling, MINE)).toBe(true);
	});

	it("does not claim the developer's own app host", () => {
		const app =
			"/Users/x/.dev3.0/native-host-images/1.3.14/dev3-terminal-host h.js session-host dev3-task-96c7e614-pane-10";
		expect(isOurProcess(app, MINE)).toBe(false);
		expect(isAmbiguousProcess(app, MINE)).toBe(true);
	});

	it("claims our own leaked host, which carries this checkout", () => {
		const ours = `${MINE.repoRoot}/build/dev3-terminal-host h.js session-host dev3-task-00000000-0000-4000-8000-00000000e2e5-pane-1`;
		expect(isOurProcess(ours, MINE)).toBe(true);
		expect(isAmbiguousProcess(ours, MINE)).toBe(false);
	});

	it("skips itself so the runner is never its own orphan", () => {
		const entries = [{ pid: 99, command: `bun ${MINE.repoRoot}/scripts/run-terminal-e2e.ts /tmp/d3or-x` }];
		const match = (command: string): boolean => isOurProcess(command, MINE);
		expect(processKeys(entries, 99, match).size).toBe(0);
		expect(processKeys(entries, 1, match).size).toBe(1);
	});
});

describe("the orphan verdict", () => {
	it("ignores what already existed before the run", () => {
		const baseline = new Set(["501\tdev3-terminal-host [1400 pane-1]"]);
		const now = new Set(["501\tdev3-terminal-host [1400 pane-1]"]);
		expect(survivors(baseline, now)).toEqual([]);
	});

	it("reports a host the run left behind", () => {
		const baseline = new Set(["501\tdev3-terminal-host [1400 pane-1]"]);
		const now = new Set(["501\tdev3-terminal-host [1400 pane-1]", "777\tdev3-terminal-host [1422 pane-1]"]);
		expect(survivors(baseline, now)).toEqual(["777\tdev3-terminal-host [1422 pane-1]"]);
	});

	it("treats a recycled pid running something of ours as new", () => {
		const baseline = new Set(["501\tdev3-terminal-host [1400 pane-1]"]);
		const now = new Set(["501\tdev3-terminal-host [1422 pane-2]"]);
		expect(survivors(baseline, now)).toEqual(["501\tdev3-terminal-host [1422 pane-2]"]);
	});

	it("fails an orphaned or leaking run, not just a non-zero exit", () => {
		expect(verdictOf(clean(), false)).toBe("passed");
		expect(verdictOf(clean({ ok: false }), false)).toBe("FAILED");
		expect(verdictOf(clean({ orphans: ["777\tdev3-live-guarded-1"] }), false)).toBe("ORPHANED");
		expect(verdictOf(clean({ tempLeaks: ["d3or-xyz"] }), true)).toBe("LEAKED");
		expect(isClean(clean({ orphans: ["777\tdev3-live-guarded-1"] }), false)).toBe(false);
	});

	it("fails an attributable orphan in both environments", () => {
		const result = clean({ orphans: ["777\tdev3-live-guarded-1"] });
		expect(verdictOf(result, true)).toBe("ORPHANED");
		expect(verdictOf(result, false)).toBe("ORPHANED");
		expect(shouldStop(result, true)).toBe(true);
		expect(shouldStop(result, false)).toBe(true);
	});

	// The tier-3 trade, stated as a test so nobody has to trust the prose: in CI an
	// unattributable host is a leak, locally it is only reported.
	it("fails an unattributable host in CI and only reports it locally", () => {
		const result = clean({ ambiguous: ["777\tdev3-terminal-host h.js session-host dev3-task-real-pane-1"] });
		expect(verdictOf(result, true)).toBe("ORPHANED");
		expect(verdictOf(result, false)).toBe("passed");
		expect(shouldStop(result, true)).toBe(true);
		expect(shouldStop(result, false)).toBe(false);
	});

	it("keeps a non-empty warning for the local case — the only thing holding that hole open", () => {
		expect(AMBIGUOUS_LOCAL_WARNING).toMatch(/\S/);
		expect(AMBIGUOUS_LOCAL_WARNING).toMatch(/In CI it would fail/);
		expect(AMBIGUOUS_LOCAL_WARNING).toMatch(/NOT failed/);
	});
});

describe("the evidence file", () => {
	it("names the survivor, the script, and which environment judged it", () => {
		const evidence = renderEvidence(
			[
				clean(),
				clean({
					name: "pane-input-owner-e2e",
					orphans: ["777\tdev3-terminal-host h.js session-host dev3-task-00000000-0000-4000-8000-00000000e2e5-pane-1"],
					tempLeaks: ["d3or-xyz"],
				}),
			],
			false,
		);
		expect(evidence).toContain("## test:pane-input-owner-e2e — ORPHANED");
		expect(evidence).toContain("CI=false");
		expect(evidence).toContain("orphan (attributable): 777 dev3-terminal-host");
		expect(evidence).toContain("leftover temp dir: d3or-xyz");
		expect(evidence, "a passing script has nothing to explain").not.toContain("tmux-guarded-send");
	});

	it("records an unattributable survivor even when it did not fail the run", () => {
		const evidence = renderEvidence([clean({ ambiguous: ["777\tdev3-terminal-host h.js"] })], false);
		expect(evidence).toContain("orphan (unattributable): 777 dev3-terminal-host");
	});

	it("counts every kind of survivor as worth writing down", () => {
		expect(hasSurvivors(clean())).toBe(false);
		expect(hasSurvivors(clean({ ok: false }))).toBe(false);
		expect(hasSurvivors(clean({ orphans: ["777\tx"] }))).toBe(true);
		expect(hasSurvivors(clean({ ambiguous: ["777\tx"] }))).toBe(true);
		expect(hasSurvivors(clean({ tempLeaks: ["d3or-x"] }))).toBe(true);
	});

	it("is empty when nothing survived, so an empty artifact means a clean run", () => {
		expect(renderEvidence([clean(), clean({ name: "native-message-e2e" })], false)).toBe("");
	});
});

describe("the runtime readout", () => {
	it("states each script's runtime and the total", () => {
		const table = renderRuntimeTable([clean(), clean({ name: "native-message-e2e", ms: 12_400 })], false);
		expect(table).toContain("| `test:tmux-guarded-send-e2e` | fast | 6.4 s | passed |");
		expect(table).toContain("| `test:native-message-e2e` | fast | 12.4 s | passed |");
		expect(table).toContain("**total (2 scripts)**");
		expect(table).toContain("**18.8 s**");
		expect(table).toContain("all passed");
	});

	it("counts the failures in the total row", () => {
		expect(renderRuntimeTable([clean({ ok: false })], false)).toContain("1 failed");
	});
});
