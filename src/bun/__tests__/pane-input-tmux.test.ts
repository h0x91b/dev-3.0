import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The tmux adapter against a mocked TmuxClient. One stage is ONE guarded command, so
// these cases are about what that guard's answer means, not about argv shape — the
// command itself is covered by the client's own tests and a live tmux regression.
vi.mock("../tmux", () => ({
	tmux: { sendKeysGuarded: vi.fn() },
	isTmuxSpawnError: (err: unknown) => (err as { spawnFailure?: boolean })?.spawnFailure === true,
	isTmuxTimeoutError: (err: unknown) => (err as { timedOut?: boolean })?.timedOut === true,
}));
vi.mock("../logger", () => ({
	createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { tmux } from "../tmux";
import { executeTmuxPaneInput, tmuxStepPayload } from "../pane-input-tmux";
import {
	PANE_INPUT_KEYS,
	PANE_INPUT_LIMITS,
	type PaneIncarnation,
	type PaneInputProgram,
	type PaneInputStage,
} from "../../shared/pane-input";
import type { PaneInputExecution } from "../pane-input-ledger";

const TASK_ID = "ef0ea197-8cac-4134-99dc-1566191ccca7";
const SESSION = "dev3-task-ef0ea197";
const PANE = "%3";
const SERVER_TOKEN = "srv-token-1";
const SOCKET = "dev3";

const INCARNATION: PaneIncarnation = {
	backend: "tmux",
	taskId: TASK_ID,
	paneId: PANE,
	sessionName: SESSION,
	serverToken: SERVER_TOKEN,
};

function program(stages: PaneInputStage[], overrides: Partial<PaneInputProgram> = {}): PaneInputProgram {
	return { deliveryId: "d1", attempt: 1, incarnation: INCARNATION, stages, ...overrides };
}

/** An admitted execution with a generous budget, unless a case wants a tight one. */
function execution(budgetMs = 60_000, progress: (n: number) => void = () => undefined): PaneInputExecution {
	return {
		progress,
		deadlineAtMs: Number(process.hrtime.bigint() / 1_000_000n) + budgetMs,
		signal: new AbortController().signal,
	};
}

/** An execution whose deadline already fired and whose signal is aborted. */
function abortedExecution(): PaneInputExecution {
	const controller = new AbortController();
	controller.abort();
	return { progress: () => undefined, deadlineAtMs: Number(process.hrtime.bigint() / 1_000_000n) + 60_000, signal: controller.signal };
}

/** tmux ran and exited non-zero — most often "can't find pane". */
function exitFailure(message = "can't find pane: %3"): Error {
	return new Error(message);
}

/** tmux never ran: the binary could not be launched. */
function spawnFailure(): Error {
	return Object.assign(new Error("tmux: not found"), { spawnFailure: true });
}

/** tmux was launched, overran its budget, and was killed and reaped. */
function timeoutFailure(stopConfirmed = true): Error {
	return Object.assign(new Error("tmux if-shell did not finish within 20ms"), { timedOut: true, stopConfirmed });
}

const TEXT: PaneInputStage[] = [{ steps: [{ kind: "text", text: "hello" }] }];

/** "Type this, wait, submit" as two stages — the shape callers build by hand. */
function submitStages(text: string, submitDelayMs: number): PaneInputStage[] {
	return [
		{ steps: [{ kind: "text", text }] },
		{ delayBeforeMs: submitDelayMs, steps: [{ kind: "key", key: "enter" }] },
	];
}

beforeEach(() => {
	vi.mocked(tmux.sendKeysGuarded).mockResolvedValue({ sent: true, inMode: false });
});

afterEach(() => vi.clearAllMocks());

// The key table and the chunking are asserted where they are observable: the chunks a
// delivery hands to the guarded command.
describe("the tmux key table covers the neutral set", () => {
	/** The chunks one stage produced, as tmux received them. */
	async function chunksOf(stage: PaneInputStage): Promise<unknown> {
		await executeTmuxPaneInput(program([stage]), SOCKET, execution());
		const calls = vi.mocked(tmux.sendKeysGuarded).mock.calls;
		return calls[calls.length - 1]?.[0].chunks;
	}

	it("names every neutral key uniquely, in tmux's own spelling", async () => {
		const names: string[] = [];
		for (const key of PANE_INPUT_KEYS) {
			const chunks = (await chunksOf({ steps: [{ kind: "key", key }] })) as { keys: string[] }[];
			names.push(chunks[0]?.keys?.[0] ?? "");
		}
		expect(names.every(Boolean)).toBe(true);
		expect(new Set(names).size).toBe(names.length);
		// tmux's spelling, which the neutral set deliberately does not use.
		await expect(chunksOf({ steps: [{ kind: "key", key: "left" }] })).resolves.toEqual([{ keys: ["Left"] }]);
		await expect(chunksOf({ steps: [{ kind: "key", key: "backspace" }] })).resolves.toEqual([{ keys: ["BSpace"] }]);
		await expect(chunksOf({ steps: [{ kind: "key", key: "ctrl-c" }] })).resolves.toEqual([{ keys: ["C-c"] }]);
	});

	it("accounts a step's size in what tmux actually receives", () => {
		expect(tmuxStepPayload({ kind: "text", text: "hi" })).toBe("hi");
		expect(tmuxStepPayload({ kind: "key", key: "left", count: 2 })).toBe("LeftLeft");
	});

	it("keeps literal text and key names apart in order, merging adjacent runs into one command", async () => {
		await expect(
			chunksOf({
				steps: [
					{ kind: "text", text: "ab" },
					{ kind: "key", key: "left", count: 2 },
					{ kind: "text", text: "cd" },
				],
			}),
		).resolves.toEqual([{ literal: "ab" }, { keys: ["Left", "Left"] }, { literal: "cd" }]);
		await expect(
			chunksOf({
				steps: [
					{ kind: "text", text: "a" },
					{ kind: "text", text: "b" },
					{ kind: "key", key: "left" },
					{ kind: "key", key: "right" },
				],
			}),
		).resolves.toEqual([{ literal: "ab" }, { keys: ["Left", "Right"] }]);
	});
});

describe("one stage is one guarded command", () => {
	it("passes the pinned incarnation, the remaining budget and the abort signal to the guard", async () => {
		const outcome = await executeTmuxPaneInput(program(TEXT), SOCKET, execution(1_500));

		expect(tmux.sendKeysGuarded).toHaveBeenCalledTimes(1);
		const call = vi.mocked(tmux.sendKeysGuarded).mock.calls[0]?.[0];
		expect(call).toMatchObject({
			pane: PANE,
			serverToken: SERVER_TOKEN,
			session: SESSION,
			socket: SOCKET,
			chunks: [{ literal: "hello" }],
		});
		// Bounded by the remaining budget and abortable, so a hung tmux is killed.
		expect(call?.timeoutMs ?? 0).toBeGreaterThan(0);
		expect(call?.timeoutMs ?? 0).toBeLessThanOrEqual(1_500);
		expect(call?.signal).toBeInstanceOf(AbortSignal);
		expect(outcome).toMatchObject({ status: "delivered", acceptedThrough: 1, backend: "tmux" });
	});

	it("sends one command per stage and reports progress as each is accepted", async () => {
		const seen: number[] = [];
		const outcome = await executeTmuxPaneInput(
			program(submitStages("deploy", 1)),
			SOCKET,
			execution(60_000, (n) => seen.push(n)),
		);
		expect(tmux.sendKeysGuarded).toHaveBeenCalledTimes(2);
		expect(vi.mocked(tmux.sendKeysGuarded).mock.calls[1]?.[0].chunks).toEqual([{ keys: ["Enter"] }]);
		expect(seen).toEqual([1, 2]);
		expect(outcome).toMatchObject({ status: "delivered", acceptedThrough: 2 });
	});

	it("refuses a program pinned to the wrong backend", async () => {
		const native = program(TEXT, {
			incarnation: {
				backend: "native",
				taskId: TASK_ID,
				paneId: "pane-1",
				sessionId: "s",
				host: { pid: 1, startSignature: "h" },
				shell: { pid: 2, startSignature: "s" },
			},
		});
		const outcome = await executeTmuxPaneInput(native, SOCKET, execution());
		expect(tmux.sendKeysGuarded).not.toHaveBeenCalled();
		expect(outcome).toMatchObject({ status: "not-started", reason: "invalid-input" });
	});
});

describe("a false guard means nothing was sent", () => {
	it("reports pane-in-mode, retryable, when copy mode alone refused; keeps the accepted prefix on a later false guard", async () => {
		vi.mocked(tmux.sendKeysGuarded).mockResolvedValue({ sent: false, inMode: true });
		expect(await executeTmuxPaneInput(program(TEXT), SOCKET, execution())).toMatchObject({
			status: "not-started",
			reason: "pane-in-mode",
			retryableAsNewDelivery: true,
		});

		vi.mocked(tmux.sendKeysGuarded)
			.mockReset()
			.mockResolvedValueOnce({ sent: true, inMode: false })
			.mockResolvedValueOnce({ sent: false, inMode: false });
		const outcome = await executeTmuxPaneInput(program(submitStages("hi", 1)), SOCKET, execution());
		expect(outcome).toMatchObject({
			status: "partial",
			acceptedThrough: 1,
			uncertainStep: null,
			reason: "incarnation-changed",
		});
	});
});

describe("a failure's verdict follows its dispatch phase", () => {
	it("treats a spawn failure as nothing having happened, mid-program as a clean partial", async () => {
		vi.mocked(tmux.sendKeysGuarded).mockRejectedValue(spawnFailure());
		expect(await executeTmuxPaneInput(program(TEXT), SOCKET, execution())).toMatchObject({
			status: "not-started",
			reason: "backend-failure",
		});

		vi.mocked(tmux.sendKeysGuarded).mockReset();
		vi.mocked(tmux.sendKeysGuarded).mockResolvedValueOnce({ sent: true, inMode: false }).mockRejectedValueOnce(spawnFailure());
		const outcome = await executeTmuxPaneInput(program(submitStages("hi", 1)), SOCKET, execution());
		expect(outcome).toMatchObject({ status: "partial", acceptedThrough: 1, uncertainStep: null });
	});

	/**
	 * A stage can be several nested send-keys, so a non-zero exit AFTER the command was
	 * spawned may already have applied a prefix. Only an explicit false guard proves
	 * nothing was sent.
	 */
	it("treats any post-spawn non-zero exit as indeterminate, bounded by the whole current stage", async () => {
		vi.mocked(tmux.sendKeysGuarded).mockRejectedValue(exitFailure());
		expect(await executeTmuxPaneInput(program(TEXT), SOCKET, execution())).toMatchObject({
			status: "indeterminate",
			possiblyAcceptedThrough: 1,
			reason: "backend-failure",
		});

		const multi = program([
			{
				steps: [
					{ kind: "text", text: "a" },
					{ kind: "key", key: "left" },
					{ kind: "text", text: "b" },
				],
			},
		]);
		expect(await executeTmuxPaneInput(multi, SOCKET, execution())).toMatchObject({
			status: "indeterminate",
			possiblyAcceptedThrough: 3,
		});

		// Mid-program: the accepted prefix counts into the bound.
		vi.mocked(tmux.sendKeysGuarded).mockReset();
		vi.mocked(tmux.sendKeysGuarded).mockResolvedValueOnce({ sent: true, inMode: false }).mockRejectedValueOnce(exitFailure());
		expect(await executeTmuxPaneInput(program(submitStages("hi", 1)), SOCKET, execution())).toMatchObject({
			status: "indeterminate",
			possiblyAcceptedThrough: 2,
			reason: "backend-failure",
		});
	});

	// The command was killed to free the caller, so whether tmux applied it first is
	// unknowable — the one case that must never read as a clean stop. An unconfirmed stop
	// is reported as such: ordering safety on tmux comes from the server serializing
	// commands across clients, not from a ledger quarantine (native-only).
	it("treats a killed command as indeterminate, and an unconfirmed stop as backend-failure", async () => {
		vi.mocked(tmux.sendKeysGuarded).mockRejectedValue(timeoutFailure());
		expect(await executeTmuxPaneInput(program(TEXT), SOCKET, execution())).toMatchObject({
			status: "indeterminate",
			possiblyAcceptedThrough: 1,
			reason: "deadline-exceeded",
		});
		vi.mocked(tmux.sendKeysGuarded).mockRejectedValue(timeoutFailure(false));
		expect(await executeTmuxPaneInput(program(TEXT), SOCKET, execution())).toMatchObject({
			status: "indeterminate",
			reason: "backend-failure",
		});
	});
});

// The constant and the wire format are coupled: raising maxStageBytes without redoing this
// arithmetic makes every Linux send die E2BIG, or blows the native host frame — both of
// which a limit-relative size test would happily pass.
describe("one stage still fits what each backend can physically carry", () => {
	/** Linux caps a SINGLE argv element at this many bytes. */
	const MAX_ARG_STRLEN = 131_072;
	/** The native host control frame, with the payload base64-encoded inside it. */
	const NATIVE_FRAME_BYTES = 65_536;
	/**
	 * tmux's own ceiling, and the one that actually binds: a whole command line rides one
	 * imsg frame. Measured against tmux 3.6a — 16 344 bytes accepted, 16 345 answered
	 * `command too long`. Argv arithmetic alone passed happily while every large message
	 * died at the server.
	 */
	const TMUX_COMMAND_BYTES = 16_344;

	/** `paste-buffer -d -p -r -b dev3-paste-<uuid> -t %999`, the widest a literal chunk gets. */
	const PASTE_COMMAND = `paste-buffer -d -p -r -b dev3-paste-${"x".repeat(36)} -t %999`.length;

	// Text no longer rides the command list at all: it goes in on its own `set-buffer`
	// command, and the guarded list only names the buffer. Two commands, two ceilings.
	it("keeps the buffer load that carries the text inside tmux's command-length ceiling", () => {
		const load = `set-buffer -b dev3-paste-${"x".repeat(36)} -- `.length + PANE_INPUT_LIMITS.maxStageBytes;
		expect(load).toBeLessThan(TMUX_COMMAND_BYTES);
		expect(load).toBeLessThan(MAX_ARG_STRLEN);
	});

	it("keeps the worst-case guarded tmux command inside tmux's own command-length ceiling", () => {
		const guard = "if-shell -t %999 -F ".length + 160;
		const worstCaseCommand =
			PANE_INPUT_LIMITS.maxSteps * PASTE_COMMAND +
			PANE_INPUT_LIMITS.maxSteps * " ; ".length +
			"display-message -p dev3-pane-input-sent".length +
			guard;
		expect(worstCaseCommand).toBeLessThan(TMUX_COMMAND_BYTES);
	});

	it("keeps the worst-case tmux argv element and the native frame inside their ceilings", () => {
		// The command list shares ONE argv element: a `paste-buffer` per chunk, the ` ; `
		// joins, and the marker command. The per-chunk shape is measured against the real
		// encoder in tmux client.test.ts.
		const joins = PANE_INPUT_LIMITS.maxSteps * " ; ".length;
		const marker = "display-message -p dev3-pane-input-sent".length;
		expect(PANE_INPUT_LIMITS.maxSteps * PASTE_COMMAND + joins + marker).toBeLessThan(MAX_ARG_STRLEN);
		// Native writes the bytes straight to the PTY; base64 is 4 bytes out per 3 in, and
		// the frame also carries its JSON envelope.
		const worstCaseFrame = Math.ceil(PANE_INPUT_LIMITS.maxStageBytes / 3) * 4;
		expect(worstCaseFrame).toBeLessThan(NATIVE_FRAME_BYTES);
	});
});

// The verdict for a pane that vanished between pin and send was unpinned in both
// directions, so flipping it silently was free.
describe("a pane that vanished between pin and send", () => {
	it("reports a clean not-started when the guard proves nothing was sent", async () => {
		vi.mocked(tmux.sendKeysGuarded).mockResolvedValue({ sent: false, inMode: false });
		const outcome = await executeTmuxPaneInput(program(TEXT), SOCKET, execution());
		// Not retryable by canon: the caller must PIN again, not resend against a pane whose
		// incarnation it can no longer vouch for.
		expect(outcome).toMatchObject({
			status: "not-started",
			reason: "incarnation-changed",
			retryableAsNewDelivery: false,
		});
	});

	it("reports uncertainty when tmux exits non-zero, because a prefix may have landed", async () => {
		vi.mocked(tmux.sendKeysGuarded).mockRejectedValue(new Error("no such pane"));
		const outcome = await executeTmuxPaneInput(program(submitStages("deploy", 1)), SOCKET, execution());
		expect(outcome).toMatchObject({ status: "indeterminate", reason: "backend-failure" });
	});
});

describe("the deadline is a real budget, and it comes from admission", () => {
	it("sends nothing once aborted or with a spent budget, and stops before a delay it cannot afford", async () => {
		expect(await executeTmuxPaneInput(program(TEXT), SOCKET, abortedExecution())).toMatchObject({
			status: "not-started",
			reason: "deadline-exceeded",
		});
		expect(await executeTmuxPaneInput(program(TEXT), SOCKET, execution(-1))).toMatchObject({
			status: "not-started",
			reason: "deadline-exceeded",
		});
		expect(tmux.sendKeysGuarded).not.toHaveBeenCalled();

		// A delay the budget cannot cover ends the run, keeping the accepted prefix.
		const outcome = await executeTmuxPaneInput(program(submitStages("hi", 5_000)), SOCKET, execution(20));
		expect(tmux.sendKeysGuarded).toHaveBeenCalledTimes(1);
		expect(outcome).toMatchObject({ status: "partial", acceptedThrough: 1, reason: "deadline-exceeded" });
	});
});
