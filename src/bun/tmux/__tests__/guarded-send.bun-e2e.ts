#!/usr/bin/env bun
/**
 * Guarded send against a REAL tmux server, on the real Bun runtime so every tmux call
 * goes through the production TmuxClient and the project spawn wrapper — no second spawn
 * path. Run: `bun run test:tmux-guarded-send-e2e`.
 */

import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TmuxClient } from "../client";
import { PANE_ID_FORMAT, PANE_IN_MODE_FORMAT, PANE_PID_FORMAT } from "../formats";
import { isTmuxError } from "../errors";

const SOCKET = `dev3-live-guarded-${process.pid}`;
const client = new TmuxClient({ socket: SOCKET });

/** One session per role, so "moved to another task" is literally another session. */
const MINE = "dev3-live-mine";
const OTHER = "dev3-live-other";

let root = "";
let minePane = "";
let otherPane = "";
let serverToken = "";
let failures = 0;
const readyOffset: Record<"mine" | "other", number> = { mine: 0, other: 0 };

function check(condition: boolean, message: string): void {
	console.log(`  ${condition ? "ok  " : "FAIL"} - ${message}`);
	if (!condition) failures += 1;
}

/** What a pid is running right now, or "" when it is gone. Read-only. */
function commandOfPid(pid: number): string {
	try {
		return execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf-8" }).trim();
	} catch {
		return "";
	}
}

function sink(name: string): string {
	return join(root, `${name}.txt`);
}

/**
 * What a pane received AFTER the readiness handshake. The sink cannot be truncated: the
 * pane's `cat` holds an open descriptor and would write past the old offset, so the
 * handshake's own bytes are skipped by position instead.
 */
function received(name: "mine" | "other"): string {
	try {
		return readFileSync(sink(name), "utf8").slice(readyOffset[name]);
	} catch {
		return "";
	}
}

const settle = (ms = 250): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function setUp(): Promise<void> {
	readyOffset.mine = 0;
	readyOffset.other = 0;
	root = mkdtempSync(join(tmpdir(), "dev3-guarded-send-"));
	// `stty raw` then `cat > file` makes every byte the pane receives observable at once:
	// no line discipline holding input back, no CR translation.
	for (const [session, name] of [
		[MINE, "mine"],
		[OTHER, "other"],
	] as const) {
		await client.newSessionDetached({
			sessionName: session,
			socket: SOCKET,
			command: `sh -c 'stty raw -echo; cat > ${sink(name)}'`,
			cwd: root,
		});
	}

	serverToken = await client.ensureServerToken({ socket: SOCKET, candidate: `srv-${process.pid}` });
	[minePane] = (await client.listPanes(PANE_ID_FORMAT, { target: MINE, socket: SOCKET })).map((row) => row.paneId);
	[otherPane] = (await client.listPanes(PANE_ID_FORMAT, { target: OTHER, socket: SOCKET })).map((row) => row.paneId);
	check(Boolean(minePane) && Boolean(otherPane), "two real panes exist on the throwaway server");
	// A bounded READY handshake, not a sleep: send a marker until the sink echoes it, so a
	// byte can no longer be lost to a shell that had not reached `cat` yet.
	check(await waitUntilReady(minePane, "mine"), "the mine pane is reading input");
	check(await waitUntilReady(otherPane, "other"), "the other pane is reading input");
	// Everything a case asserts starts after the handshake.
	for (const name of ["mine", "other"] as const) {
		readyOffset[name] = readFileSync(sink(name), "utf8").length;
	}
}

/** Send a marker until the pane's sink shows it, or give up after a bounded wait. */
async function waitUntilReady(pane: string, name: "mine" | "other"): Promise<boolean> {
	const marker = `READY-${name}-${process.pid}`;
	for (let attempt = 0; attempt < 40; attempt += 1) {
		await client
			.sendKeysGuarded({ pane, serverToken, agentFence: "", session: name === "mine" ? MINE : OTHER, chunks: [{ literal: marker }], socket: SOCKET })
			.catch(() => undefined);
		await settle(100);
		if (received(name).includes(marker)) return true;
	}
	return false;
}

async function tearDown(): Promise<void> {
	for (const session of [MINE, OTHER]) {
		await client.killSession(session, { socket: SOCKET, bestEffort: true }).catch(() => undefined);
	}
	// The pid-keyed socket FILE outlives the server unless we unlink it.
	await client.killServer({ socket: SOCKET });
	rmSync(root, { recursive: true, force: true });
}

/** The exact bytes arrive, quoting hazards and multibyte text included. */
async function deliversExactBytes(): Promise<void> {
	const text = "a'b;c#{pid}\"d-N 日本語";
	const { sent } = await client.sendKeysGuarded({
		pane: minePane,
		serverToken,
		agentFence: "",
		session: MINE,
		chunks: [{ literal: text }, { keys: ["Left", "Left"] }],
		socket: SOCKET,
	});
	check(sent, "the guard held and the keys went out");
	await settle();
	check(received("mine") === `${text}\x1b[D\x1b[D`, "the exact bytes arrived, arrows included");
}

/** The pane keeps its id and its shell; only its session changes. */
async function sendsNothingAfterAMove(): Promise<void> {
	await client.movePane({ source: minePane, target: `${OTHER}:`, socket: SOCKET });
	await settle();
	const { sent, inMode } = await client.sendKeysGuarded({
		pane: minePane,
		serverToken,
		agentFence: "",
		session: MINE,
		chunks: [{ literal: "MUST-NOT-ARRIVE" }],
		socket: SOCKET,
	});
	check(!sent, "a moved pane reports nothing sent");
	check(!inMode, "a moved pane is not reported as copy mode");
	await settle();
	check(received("mine") === "", "nothing reached the moved pane");
	check(received("other") === "", "nothing reached the other task either");
}

/** A restarted server mints a new token, so a pin against the old one stops matching. */
async function sendsNothingForAnotherServer(): Promise<void> {
	const { sent } = await client.sendKeysGuarded({
		pane: minePane,
		serverToken: `${serverToken}-other`,
		agentFence: "",
		session: MINE,
		chunks: [{ literal: "MUST-NOT-ARRIVE" }],
		socket: SOCKET,
	});
	check(!sent, "a foreign server token reports nothing sent");
	await settle();
	check(received("mine") === "", "nothing reached the pane");
}

/**
 * A pane this server does not have cannot be resolved for the guard's format, so the
 * guard is false and tmux exits 0 — gone, moved and never-existed look the same.
 */
async function sendsNothingForAnUnknownPane(): Promise<void> {
	const { sent } = await client.sendKeysGuarded({
		pane: "%999",
		serverToken,
		agentFence: "",
		session: MINE,
		chunks: [{ literal: "MUST-NOT-ARRIVE" }],
		socket: SOCKET,
	});
	check(!sent, "an unknown pane reports nothing sent, without throwing");
	await settle();
	check(received("mine") === "" && received("other") === "", "nothing reached any pane");
}

/** The preflight PROVES presence and absence, and never writes. */
async function observesPresenceAndAbsence(): Promise<void> {
	const present = await client.observePane({ pane: minePane, socket: SOCKET });
	check(present.kind === "present" && present.sessionName === MINE, "a live pane is observed in its own session");
	const missing = await client.observePane({ pane: "%999", socket: SOCKET });
	check(missing.kind === "absent", "a pane this server does not have is observed absent");
	await settle();
	check(received("mine") === "", "observing wrote nothing");
}

/** A pane moved AFTER the preflight is still refused by the guard, with zero input. */
async function guardRefusesAMoveAfterPreflight(): Promise<void> {
	const before = await client.observePane({ pane: minePane, socket: SOCKET });
	check(before.kind === "present", "the preflight sees the pane in this session");
	// The race the preflight cannot close, which is why the guard is the authority.
	await client.movePane({ source: minePane, target: `${OTHER}:`, socket: SOCKET });
	const { sent } = await client.sendKeysGuarded({
		pane: minePane,
		serverToken,
		agentFence: "",
		session: MINE,
		chunks: [{ literal: "MUST-NOT-ARRIVE" }],
		socket: SOCKET,
	});
	check(!sent, "the guard refuses a pane that moved after the preflight");
	await settle();
	check(received("mine") === "" && received("other") === "", "nothing reached either pane");
}

/**
 * A pane that DIES after the preflight. `remain-on-exit` keeps it listed and addressable,
 * so only pane_dead inside the guard can stop the send.
 */
async function guardRefusesADeathAfterPreflight(): Promise<void> {
	await client.setPaneOption(minePane, "remain-on-exit", "on", { socket: SOCKET });
	const before = await client.observePane({ pane: minePane, socket: SOCKET });
	check(before.kind === "present", "the preflight sees the pane alive");

	// Kill the pane's own process: in raw mode C-d is not EOF, so the shell has to be ended
	// from outside for tmux to mark the pane dead. A pid alone is NOT permission to signal —
	// the OS hands it to an unrelated successor — so the pid must still be running this run's
	// own sink path, under a mkdtemp root no other process can name.
	const [pidRow] = await client.listPanes(PANE_PID_FORMAT, { target: MINE, socket: SOCKET });
	check(Boolean(pidRow?.panePid), "the pane's process id is observable");
	const pid = pidRow?.panePid ?? 0;
	const command = commandOfPid(pid);
	const ours = pid > 0 && command.includes(sink("mine"));
	check(ours, `the pid is proven to be this run's own pane process before any signal (${command || "gone"})`);
	if (!ours) return;
	process.kill(pid, "SIGKILL");
	let dead = false;
	for (let attempt = 0; attempt < 20 && !dead; attempt += 1) {
		await settle(150);
		dead = (await client.observePane({ pane: minePane, socket: SOCKET })).kind === "dead";
	}
	check(dead, "tmux reports the pane dead while still listing it");

	const { sent, inMode } = await client.sendKeysGuarded({
		pane: minePane,
		serverToken,
		agentFence: "",
		session: MINE,
		chunks: [{ literal: "MUST-NOT-ARRIVE" }],
		socket: SOCKET,
	});
	check(!sent, "the guard refuses a pane that died after the preflight");
	check(!inMode, "a dead pane is not reported as copy mode");
	check(!received("mine").includes("MUST-NOT-ARRIVE"), "the dead pane received nothing");
}

/**
 * The restart hazard, end to end: a new server hands out the SAME pane id %0 under a new
 * token. A pin that paired generation A's pane with generation B's token would look valid
 * here and write into a stranger's shell.
 */
async function refusesARecycledPaneIdAfterARestart(): Promise<void> {
	const first = await client.observePane({ pane: minePane, socket: SOCKET });
	check(first.kind === "present", "the first generation lists the pane");
	const tokenA = first.kind === "present" ? first.serverToken : "";

	// Killing every session ends the server, which takes its pane-id counter with it.
	for (const session of [MINE, OTHER]) {
		await client.killSession(session, { socket: SOCKET, bestEffort: true }).catch(() => undefined);
	}
	await settle();
	await client.newSessionDetached({
		sessionName: MINE,
		socket: SOCKET,
		command: `sh -c 'stty raw -echo; cat > ${sink("restarted")}'`,
		cwd: root,
	});
	const tokenB = await client.ensureServerToken({ socket: SOCKET, candidate: `srv-${process.pid}-b` });
	const second = await client.observePane({ pane: minePane, socket: SOCKET });
	check(second.kind === "present", "the new generation lists a pane under the recycled id");
	check(tokenB !== tokenA && (second.kind === "present" ? second.serverToken : "") === tokenB, "the recycled pane id now belongs to a different generation");

	const { sent } = await client.sendKeysGuarded({
		pane: minePane,
		serverToken: tokenA,
		agentFence: "",
		session: MINE,
		chunks: [{ literal: "MUST-NOT-ARRIVE" }],
		socket: SOCKET,
	});
	check(!sent, "the guard refuses the old generation's token on a recycled pane id");
	await settle();
	let landed = "";
	try {
		landed = readFileSync(sink("restarted"), "utf8");
	} catch {
		landed = "";
	}
	check(!landed.includes("MUST-NOT-ARRIVE"), `nothing reached the new generation's shell (sink=${JSON.stringify(landed)})`);
}

/**
 * A pane in copy mode routes send-keys through the MODE key table. Measured before the
 * guard covered it: `sent: true`, `pane_in_mode: true`, sink empty — a false `delivered`.
 * The line printed here is the measurement; the check is the fix.
 */
async function refusesAPaneSittingInCopyMode(): Promise<void> {
	await client.enterCopyMode(minePane, { socket: SOCKET });
	await settle();
	const [modeRow] = await client.listPanes(PANE_IN_MODE_FORMAT, { target: MINE, socket: SOCKET });
	const inMode = modeRow?.inMode ?? false;
	// The shared format declares paneId AND inMode; report both so the parse is observed,
	// not assumed, against a real server.
	console.log(`  MEASURED - shared PANE_IN_MODE_FORMAT parsed: paneId=${JSON.stringify(modeRow?.paneId)}, inMode=${JSON.stringify(modeRow?.inMode)}`);
	check(modeRow?.paneId === minePane, `the shared format parses the pane id (${JSON.stringify(modeRow?.paneId)} vs ${minePane})`);
	const { sent, inMode: reportedInMode } = await client.sendKeysGuarded({
		pane: minePane,
		serverToken,
		agentFence: "",
		session: MINE,
		chunks: [{ literal: "COPY-MODE-PROBE" }],
		socket: SOCKET,
	});
	// A foreign generation on a scrolled-up pane must NOT read as "only scrolled up".
	const foreign = await client.sendKeysGuarded({
		pane: minePane,
		serverToken: `${serverToken}-other`,
		agentFence: "",
		session: MINE,
		chunks: [{ literal: "COPY-MODE-PROBE" }],
		socket: SOCKET,
	});
	await settle();
	const landed = received("mine");
	console.log(`  MEASURED - copy mode: sent=${sent}, inMode=${reportedInMode}, pane_in_mode=${inMode}, sink=${JSON.stringify(landed)}`);
	await client.exitCopyMode(minePane, { socket: SOCKET }).catch(() => undefined);
	check(!sent, "the guard refuses a pane sitting in copy mode");
	check(reportedInMode, "the refusal says the pane is only in copy mode");
	check(!foreign.sent && !foreign.inMode, "a foreign token on a scrolled-up pane is not reported as copy mode");
	check(!landed.includes("COPY-MODE-PROBE"), "nothing reached the program through the mode key table");
}

/** A tmux failure that is NOT a false guard still surfaces as an error. */
async function throwsForARealTmuxFailure(): Promise<void> {
	let threw: unknown = null;
	try {
		await client.sendKeysGuarded({
			pane: minePane,
			serverToken,
			agentFence: "",
			session: MINE,
			chunks: [{ literal: "x" }],
			socket: `${SOCKET}-no-such-server`,
		});
	} catch (err) {
		threw = err;
	}
	check(isTmuxError(threw), `a dead socket throws a TmuxError (${threw === null ? "nothing thrown" : "threw"})`);
}

/** The agent fence rides in the same guard: only the pinned value passes, and a refusal names the live one. */
async function guardsTheAgentFence(): Promise<void> {
	const send = (agentFence: string, literal: string, token = serverToken) =>
		client.sendKeysGuarded({ pane: minePane, serverToken: token, agentFence, session: MINE, chunks: [{ literal }], socket: SOCKET });
	await client.setPaneOption(minePane, "@dev3_agent_input", "open:L1", { socket: SOCKET });
	const open = await send("open:L1", "FENCE-OPEN-OK");
	const legacyPin = await send("", "FENCE-LEGACY-PIN");
	const otherLaunch = await send("open:L0", "FENCE-OTHER-LAUNCH");
	await client.setPaneOption(minePane, "@dev3_agent_input", "closed:L1:143", { socket: SOCKET });
	const closed = await send("open:L1", "FENCE-CLOSED");
	const foreign = await send("open:L1", "FENCE-FOREIGN", `${serverToken}-other`);
	await settle();
	const landed = received("mine");
	console.log(`  MEASURED - open=${JSON.stringify(open)} legacyPin=${JSON.stringify(legacyPin)} closed=${JSON.stringify(closed)} foreign=${JSON.stringify(foreign)}`);
	check(open.sent && landed.includes("FENCE-OPEN-OK"), "a matching open fence delivers");
	check(!legacyPin.sent && legacyPin.liveFence === "open:L1", "a legacy pin on a fenced pane is refused and names the live fence");
	check(!otherLaunch.sent && otherLaunch.liveFence === "open:L1", "a pin of another launch is refused");
	check(!closed.sent && closed.liveFence === "closed:L1:143", "a closed fence refuses and reports closed:L1:143");
	check(!foreign.sent && foreign.liveFence === undefined, "a foreign server reports no fence at all");
	for (const marker of ["FENCE-LEGACY-PIN", "FENCE-OTHER-LAUNCH", "FENCE-CLOSED", "FENCE-FOREIGN"]) {
		check(!landed.includes(marker), `nothing refused reached the program (${marker})`);
	}
}

/** The app's close: one compare-and-set, one sentinel per launch however many instances try. */
async function closesTheFenceOnceWithOneSentinel(): Promise<void> {
	await client.setPaneOption(minePane, "@dev3_agent_input", "open:L2", { socket: SOCKET });
	const first = await client.closeAgentFence({ pane: minePane, launchId: "L2", exitCode: 143, socket: SOCKET });
	const second = await client.closeAgentFence({ pane: minePane, launchId: "L2", exitCode: 143, socket: SOCKET });
	const wrong = await client.closeAgentFence({ pane: minePane, launchId: "L3", exitCode: 0, socket: SOCKET });
	const missing = await client.closeAgentFence({ pane: "%999", launchId: "L2", exitCode: 0, socket: SOCKET });
	await settle();
	const landed = received("mine");
	const sentinels = landed.split("\x1fdev3-fence:").length - 1;
	const fences = await client.listAgentFences({ socket: SOCKET });
	console.log(`  MEASURED - first=${JSON.stringify(first)} second=${JSON.stringify(second)} wrong=${JSON.stringify(wrong)} missing=${missing.kind} sentinels=${sentinels}`);
	check(first.kind === "closed", "the first close flips open:L2 to closed");
	check(second.kind === "closed" && first.kind === "closed" && second.nonce === first.nonce, "a second close reads back the SAME nonce");
	check(sentinels === 1, `exactly one sentinel reached the pane (${sentinels})`);
	check(first.kind === "closed" && landed.includes(`\x1fdev3-fence:${first.nonce}\x1f`), "the sentinel carries the stored nonce");
	check(wrong.kind === "not-this-launch" && wrong.fence === "closed:L2:143", "another launch id closes nothing and reads the value back");
	// tmux does not abort the list on an unknown target; what matters is that nothing closed.
	check(missing.kind !== "closed", `a pane that does not exist is never reported closed (${missing.kind})`);
	check(!received("other").includes("dev3-fence:"), "no sentinel landed in any other pane");
	check(fences.some((row) => row.paneId === minePane && row.agentFence === "closed:L2:143"), "listAgentFences sees the closed fence");
}

async function main(): Promise<void> {
	const cases = [
		deliversExactBytes,
		sendsNothingAfterAMove,
		sendsNothingForAnotherServer,
		sendsNothingForAnUnknownPane,
		observesPresenceAndAbsence,
		guardRefusesAMoveAfterPreflight,
		guardRefusesADeathAfterPreflight,
		refusesARecycledPaneIdAfterARestart,
		refusesAPaneSittingInCopyMode,
		guardsTheAgentFence,
		closesTheFenceOnceWithOneSentinel,
		throwsForARealTmuxFailure,
	];
	for (const one of cases) {
		console.log(`  case - ${one.name}`);
		try {
			// Setup is inside the try: a half-built server must still be torn down.
			await setUp();
			await one();
		} finally {
			await tearDown();
		}
	}
}

main()
	.then(() => {
		console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
		process.exit(failures === 0 ? 0 : 1);
	})
	.catch((err) => {
		console.error("\nE2E CRASHED", err);
		process.exit(1);
	});
