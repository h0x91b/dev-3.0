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
	vi.mocked(tmux.sendKeysGuarded).mockResolvedValue({ sent: true });
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

	it("names every neutral key, with no duplicate name", async () => {
		const names: string[] = [];
		for (const key of PANE_INPUT_KEYS) {
			const chunks = (await chunksOf({ steps: [{ kind: "key", key }] })) as { keys: string[] }[];
			names.push(chunks[0]?.keys?.[0] ?? "");
		}
		expect(names.every(Boolean)).toBe(true);
		expect(new Set(names).size).toBe(names.length);
	});

	it("keeps tmux's own spelling, which the neutral set deliberately does not use", async () => {
		await expect(chunksOf({ steps: [{ kind: "key", key: "left" }] })).resolves.toEqual([{ keys: ["Left"] }]);
		await expect(chunksOf({ steps: [{ kind: "key", key: "backspace" }] })).resolves.toEqual([{ keys: ["BSpace"] }]);
		await expect(chunksOf({ steps: [{ kind: "key", key: "ctrl-c" }] })).resolves.toEqual([{ keys: ["C-c"] }]);
	});

	it("accounts a step's size in what tmux actually receives", () => {
		expect(tmuxStepPayload({ kind: "text", text: "hi" })).toBe("hi");
		expect(tmuxStepPayload({ kind: "key", key: "left", count: 2 })).toBe("LeftLeft");
	});

	it("keeps literal text and key names apart, in order", async () => {
		await expect(
			chunksOf({
				steps: [
					{ kind: "text", text: "ab" },
					{ kind: "key", key: "left", count: 2 },
					{ kind: "text", text: "cd" },
				],
			}),
		).resolves.toEqual([{ literal: "ab" }, { keys: ["Left", "Left"] }, { literal: "cd" }]);
	});

	it("merges adjacent text and adjacent keys so one command carries the stage", async () => {
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
	it("passes the pinned incarnation to the guard and reports delivered", async () => {
		const outcome = await executeTmuxPaneInput(program(TEXT), SOCKET, execution());

		expect(tmux.sendKeysGuarded).toHaveBeenCalledTimes(1);
		expect(vi.mocked(tmux.sendKeysGuarded).mock.calls[0]?.[0]).toMatchObject({
			pane: PANE,
			serverToken: SERVER_TOKEN,
			session: SESSION,
			socket: SOCKET,
			chunks: [{ literal: "hello" }],
		});
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

	it("bounds each command by the remaining budget, so a hung tmux is killed", async () => {
		await executeTmuxPaneInput(program(TEXT), SOCKET, execution(1_500));
		const passed = vi.mocked(tmux.sendKeysGuarded).mock.calls[0]?.[0].timeoutMs ?? 0;
		expect(passed).toBeGreaterThan(0);
		expect(passed).toBeLessThanOrEqual(1_500);
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
	// The pane moved to another session, or this is a different tmux server that minted
	// the same %id. Either way the keys never left, inside the same server turn.
	it("reports incarnation-changed and stops, with nothing accepted", async () => {
		vi.mocked(tmux.sendKeysGuarded).mockResolvedValue({ sent: false });
		const outcome = await executeTmuxPaneInput(program(TEXT), SOCKET, execution());
		expect(outcome).toMatchObject({
			status: "not-started",
			reason: "incarnation-changed",
			retryableAsNewDelivery: false,
		});
	});

	it("keeps the accepted prefix when a later stage's guard fails", async () => {
		vi.mocked(tmux.sendKeysGuarded)
			.mockResolvedValueOnce({ sent: true })
			.mockResolvedValueOnce({ sent: false });
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
	it("treats a spawn failure as nothing having happened", async () => {
		vi.mocked(tmux.sendKeysGuarded).mockRejectedValue(spawnFailure());
		const outcome = await executeTmuxPaneInput(program(TEXT), SOCKET, execution());
		expect(outcome).toMatchObject({ status: "not-started", reason: "backend-failure" });
	});

	it("treats a spawn failure mid-program as a clean partial", async () => {
		vi.mocked(tmux.sendKeysGuarded).mockResolvedValueOnce({ sent: true }).mockRejectedValueOnce(spawnFailure());
		const outcome = await executeTmuxPaneInput(program(submitStages("hi", 1)), SOCKET, execution());
		expect(outcome).toMatchObject({ status: "partial", acceptedThrough: 1, uncertainStep: null });
	});

	/**
	 * A stage can be several nested send-keys, so a non-zero exit AFTER the command was
	 * spawned may already have applied a prefix. Only an explicit false guard proves
	 * nothing was sent.
	 */
	it("treats any post-spawn non-zero exit as indeterminate, never as a clean stop", async () => {
		vi.mocked(tmux.sendKeysGuarded).mockRejectedValue(exitFailure());
		const outcome = await executeTmuxPaneInput(program(TEXT), SOCKET, execution());
		expect(outcome).toMatchObject({
			status: "indeterminate",
			possiblyAcceptedThrough: 1,
			reason: "backend-failure",
		});
	});

	it("bounds it by the whole current stage when a multi-chunk stage fails", async () => {
		vi.mocked(tmux.sendKeysGuarded).mockRejectedValue(exitFailure());
		const multi = program([
			{
				steps: [
					{ kind: "text", text: "a" },
					{ kind: "key", key: "left" },
					{ kind: "text", text: "b" },
				],
			},
		]);
		const outcome = await executeTmuxPaneInput(multi, SOCKET, execution());
		expect(outcome).toMatchObject({ status: "indeterminate", possiblyAcceptedThrough: 3 });
	});

	it("counts the accepted prefix into a mid-program non-zero exit", async () => {
		vi.mocked(tmux.sendKeysGuarded).mockResolvedValueOnce({ sent: true }).mockRejectedValueOnce(exitFailure());
		const outcome = await executeTmuxPaneInput(program(submitStages("hi", 1)), SOCKET, execution());
		expect(outcome).toMatchObject({
			status: "indeterminate",
			possiblyAcceptedThrough: 2,
			reason: "backend-failure",
		});
	});

	// The command was killed to free the caller, so whether tmux applied it first is
	// unknowable — the one case that must never read as a clean stop.
	it("treats a killed command as indeterminate, never as a clean stop", async () => {
		vi.mocked(tmux.sendKeysGuarded).mockRejectedValue(timeoutFailure());
		const outcome = await executeTmuxPaneInput(program(TEXT), SOCKET, execution());
		expect(outcome).toMatchObject({
			status: "indeterminate",
			possiblyAcceptedThrough: 1,
			reason: "deadline-exceeded",
		});
	});

	// An unconfirmed stop is reported as such. Ordering safety on tmux comes from the
	// server serializing commands across clients, not from a ledger quarantine — that
	// mechanism only ever fires on the native path.
	it("reports backend-failure when the stop itself was not confirmed", async () => {
		vi.mocked(tmux.sendKeysGuarded).mockRejectedValue(timeoutFailure(false));
		const outcome = await executeTmuxPaneInput(program(TEXT), SOCKET, execution());
		expect(outcome).toMatchObject({ status: "indeterminate", reason: "backend-failure" });
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

	it("keeps the worst-case guarded tmux command inside tmux's own command-length ceiling", () => {
		const chunkPrefix = "send-keys -t %999 -H ".length;
		const guard = "if-shell -t %999 -F ".length + 160;
		const worstCaseCommand =
			PANE_INPUT_LIMITS.maxStageBytes * 3 +
			PANE_INPUT_LIMITS.maxSteps * chunkPrefix +
			PANE_INPUT_LIMITS.maxSteps * " ; ".length +
			"display-message -p dev3-pane-input-sent".length +
			guard;
		expect(worstCaseCommand).toBeLessThan(TMUX_COMMAND_BYTES);
	});

	it("keeps the worst-case tmux argv element and the native frame inside their ceilings", () => {
		// EVERY piece shares one argv element: the hex (3 bytes per byte of text), one
		// `send-keys -t %NNN -H ` prefix per chunk, the ` ; ` joins, and the marker command.
		// The per-chunk shape is measured against the real encoder in tmux client.test.ts.
		const chunkPrefix = "send-keys -t %999 -H ".length;
		const joins = PANE_INPUT_LIMITS.maxSteps * " ; ".length;
		const marker = "display-message -p dev3-pane-input-sent".length;
		const worstCaseArgv =
			PANE_INPUT_LIMITS.maxStageBytes * 3 + PANE_INPUT_LIMITS.maxSteps * chunkPrefix + joins + marker;
		expect(worstCaseArgv).toBeLessThan(MAX_ARG_STRLEN);
		// Base64 is 4 bytes out per 3 in; the frame also carries its JSON envelope.
		const worstCaseFrame = Math.ceil(PANE_INPUT_LIMITS.maxStageBytes / 3) * 4;
		expect(worstCaseFrame).toBeLessThan(NATIVE_FRAME_BYTES);
	});
});

// The verdict for a pane that vanished between pin and send was unpinned in both
// directions, so flipping it silently was free.
describe("a pane that vanished between pin and send", () => {
	it("reports a clean not-started when the guard proves nothing was sent", async () => {
		vi.mocked(tmux.sendKeysGuarded).mockResolvedValue({ sent: false });
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
	it("stops before a delay it cannot afford, keeping the accepted prefix", async () => {
		const outcome = await executeTmuxPaneInput(program(submitStages("hi", 5_000)), SOCKET, execution(20));
		expect(tmux.sendKeysGuarded).toHaveBeenCalledTimes(1);
		expect(outcome).toMatchObject({ status: "partial", acceptedThrough: 1, reason: "deadline-exceeded" });
	});

	it("stops before a stage once the ledger aborted it", async () => {
		const outcome = await executeTmuxPaneInput(program(TEXT), SOCKET, abortedExecution());
		expect(tmux.sendKeysGuarded).not.toHaveBeenCalled();
		expect(outcome).toMatchObject({ status: "not-started", reason: "deadline-exceeded" });
	});

	it("passes the abort signal down so a hung command is killed", async () => {
		await executeTmuxPaneInput(program(TEXT), SOCKET, execution());
		expect(vi.mocked(tmux.sendKeysGuarded).mock.calls[0]?.[0].signal).toBeInstanceOf(AbortSignal);
	});

	it("honours a budget already spent before it was handed the program", async () => {
		const outcome = await executeTmuxPaneInput(program(TEXT), SOCKET, execution(-1));
		expect(tmux.sendKeysGuarded).not.toHaveBeenCalled();
		expect(outcome).toMatchObject({ status: "not-started", reason: "deadline-exceeded" });
	});
});
