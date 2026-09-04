import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	AMBIGUOUS_LOCAL_WARNING,
	isAmbiguousProcess,
	isClean,
	isOurProcess,
	isOurTempEntry,
	isOurTmuxSocket,
	liveTmuxServerSockets,
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
	serverLeaks: [],
	...over,
});

/**
 * REAL `ps` output, not a hand-written approximation of it. Measured 2026-09-04 against a
 * live tmux server started through TmuxClient, on both platforms this gate runs on:
 *
 *   macOS 15 / tmux 3.6      `ps -Ao pid=,ppid=,command=` → `84620  1  tmux -L … new-session -d …`
 *   Ubuntu 24.04 / tmux 3.4  same command                → `  272  1  tmux -L … new-session -d …`
 *
 * Both keep the argv of the command that started them, socket name included, and both
 * report ppid 1 because the server daemonises. The `tmux: server (<socket path>)`
 * proctitle asserted further down was never observed in `command=` on either platform —
 * on Linux it reaches `comm=` only, and without the path. Fixtures of real command output
 * must be pasted from a real run; see
 * `decisions/2026/09/04/measure-command-output-before-asserting-on-it.md`.
 */
const REAL_LEAKED_SERVER_MACOS =
	"tmux -L dev3-live-guarded-84602 -f /tmp/dev3-tmux-dark.conf new-session -d -s repro -c /var/folders/04/T/dev3-guarded-send-Ab12 stty raw";
const REAL_LEAKED_SERVER_LINUX = "tmux -L dev3-live-guarded-42 new-session -d -s repro sleep 300";
/** The developer's own app server, from the same `ps` dump — must never be claimed. */
const REAL_APP_SERVER =
	"/Applications/dev-3.0.app/Contents/Resources/app/tmux/tmux -L dev3 -f /tmp/dev3-tmux-dark.conf new-session -A -c /Users/x/Desktop/src-shared/dev-3.0 -s dev3-pt-a1c9fe4e /opt/homebrew/bin/zsh";

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
		const entries = parseProcessTable([`  272 ${REAL_LEAKED_SERVER_LINUX}`, "1234 bun run test:native-registry-e2e"].join("\n"));
		expect(entries).toEqual([
			{ pid: 272, command: REAL_LEAKED_SERVER_LINUX },
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
	// The load-bearing pair: whatever the guard claims about a leaked tmux server has to
	// hold for the string the operating system actually produces. A pattern that matched
	// only the proctitle form below would keep the rest of this file green while missing
	// every real leak on both platforms.
	it("claims a leaked tmux server in the form macOS and Linux really print", () => {
		expect(looksLikeSuite(REAL_LEAKED_SERVER_MACOS)).toBe(true);
		expect(looksLikeSuite(REAL_LEAKED_SERVER_LINUX)).toBe(true);
	});

	it("does not claim the developer's own app tmux server", () => {
		expect(looksLikeSuite(REAL_APP_SERVER)).toBe(false);
	});

	it("claims a stranded native host, tmux server, and throwaway-rooted shell", () => {
		// Kept as a defensive superset: this proctitle is what a platform with
		// setproctitle(3) prints, and matching it costs nothing. It is not evidence about
		// macOS or Linux — the two tests above are.
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

	// The argv-independent half of the server check: a socket either has something
	// listening on it or it does not, whatever tmux chose to call itself in `ps`.
	it("recognises the socket names the scripts mint, and neither the app's nor another suite's", () => {
		expect(isOurTmuxSocket("dev3-live-guarded-84602")).toBe(true);
		expect(isOurTmuxSocket("dev3-live-guarded-84602-no-such-server")).toBe(true);
		expect(isOurTmuxSocket("dev3"), "the app's own live server").toBe(false);
		expect(isOurTmuxSocket("dev3-e2e-18511"), "a vitest suite's socket, not this gate's").toBe(false);
		expect(isOurTmuxSocket("default")).toBe(false);
	});

	it("counts only a socket with something still listening on it", () => {
		// tmux never unlinks its own socket, so a dead file proves a server EXISTED, and an
		// unreadable one proves nothing — neither is a live leak.
		expect(
			liveTmuxServerSockets([
				{ name: "dev3-live-guarded-1", liveness: "listening" },
				{ name: "dev3-live-guarded-2", liveness: "dead" },
				{ name: "dev3-live-guarded-3", liveness: "unknown" },
				{ name: "dev3", liveness: "listening" },
			]),
		).toEqual(["dev3-live-guarded-1"]);
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

	// Same trade as an unattributable host, and for the same reason: a socket name carries
	// no repo path, so a sibling worktree running this suite could own it.
	it("fails a leaked tmux server in CI and only reports it locally", () => {
		const result = clean({ serverLeaks: ["dev3-live-guarded-84602"] });
		expect(verdictOf(result, true)).toBe("LEAKED");
		expect(verdictOf(result, false)).toBe("passed");
		expect(shouldStop(result, true)).toBe(true);
		expect(shouldStop(result, false)).toBe(false);
		expect(hasSurvivors(result), "reported even where it does not fail").toBe(true);
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

	it("names a leaked server by its socket and by the command that clears it", () => {
		const evidence = renderEvidence([clean({ serverLeaks: ["dev3-live-guarded-84602"] })], true);
		expect(evidence).toContain("live tmux server on socket: dev3-live-guarded-84602");
		expect(evidence).toContain("tmux -L dev3-live-guarded-84602 kill-server");
	});

	it("counts every kind of survivor as worth writing down", () => {
		expect(hasSurvivors(clean())).toBe(false);
		expect(hasSurvivors(clean({ ok: false }))).toBe(false);
		expect(hasSurvivors(clean({ orphans: ["777\tx"] }))).toBe(true);
		expect(hasSurvivors(clean({ ambiguous: ["777\tx"] }))).toBe(true);
		expect(hasSurvivors(clean({ tempLeaks: ["d3or-x"] }))).toBe(true);
		expect(hasSurvivors(clean({ serverLeaks: ["dev3-live-guarded-1"] }))).toBe(true);
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
