import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Native pane input against mocked pane-set, identity-reader, PTY-binding and
// owner-routing seams. ../tmux is mocked too — not because this path uses it, but so a
// stray tmux call would be visible instead of silently working.
vi.mock("../tmux", () => ({
	tmux: { sendKeysGuarded: vi.fn() },
	isTmuxSpawnError: () => false,
	isTmuxTimeoutError: () => false,
}));
vi.mock("../native-task-panes", () => ({ inspectNativeTaskPane: vi.fn() }));
vi.mock("../native-pane-identity", () => ({ inspectNativePaneIdentity: vi.fn() }));
vi.mock("../pty-server", () => ({ nativePaneTerminal: vi.fn() }));
vi.mock("../native-pane-owner", async () => {
	const actual = await vi.importActual<typeof import("../native-pane-owner")>("../native-pane-owner");
	return {
		resolvePaneOwner: vi.fn(),
		forwardToOwner: vi.fn(),
		ForwardToOwnerError: actual.ForwardToOwnerError,
		isForwardToOwnerError: actual.isForwardToOwnerError,
	};
});
vi.mock("../logger", () => ({
	createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { inspectNativeTaskPane } from "../native-task-panes";
import { inspectNativePaneIdentity } from "../native-pane-identity";
import { nativePaneTerminal } from "../pty-server";
import { ForwardToOwnerError, forwardToOwner, resolvePaneOwner } from "../native-pane-owner";
import type { NativeTaskTerminal } from "../native-task-terminal";
import { tmux } from "../tmux";
import {
	deliverNativePaneInput,
	resolveNativePaneIncarnation,
	runNativePaneInputAsOwner,
} from "../pane-input-native";

import {
	PANE_INPUT_KEYS,
	PANE_INPUT_LIMITS,
	type PaneIncarnation,
	type PaneInputProgram,
	type PaneInputStage,
} from "../../shared/pane-input";
import type { Task } from "../../shared/types";

const TASK_ID = "ef0ea197-8cac-4134-99dc-1566191ccca7";
const PANE = "pane-2";
const SESSION = `dev3-task-${TASK_ID}-${PANE}`;

/** Host and shell of the pane the programs below are pinned to. */
const A = { hostPid: 4242, shellPid: 4243, hostSig: "host-A", shellSig: "shell-A" };
/** Its successor: a fresh pair of processes behind the same pane id. */
const B = { hostPid: 5150, shellPid: 5151, hostSig: "host-B", shellSig: "shell-B" };

function task(overrides: Partial<Task> = {}): Task {
	return { id: TASK_ID, projectId: "project-1", worktreePath: "/tmp/worktree", ...overrides } as Task;
}

/** What the observational reader answers for a pane, with its ownership verdict. */
function observed(p: typeof A = A, ownership: "owned" | "dead" | "reused" = "owned") {
	return { kind: "observed" as const, ...processes(p), ownership };
}

/** What the identity reader answers for a given process pair. */
function processes(p: typeof A) {
	return {
		sessionId: SESSION,
		host: { pid: p.hostPid, startSignature: p.hostSig },
		shell: { pid: p.shellPid, startSignature: p.shellSig },
	};
}

function incarnationOf(p: typeof A): PaneIncarnation {
	return { backend: "native", taskId: TASK_ID, paneId: PANE, ...processes(p) };
}

/** A fake binding whose role is scriptable, recording every byte written. */
function fakeTerminal(
	p: typeof A = A,
	role: "writer" | "observer" = "writer",
	overrides: { boundIdentity?: unknown } = {},
) {
	const writes: string[] = [];
	let currentRole = role;
	const terminal = {
		sessionId: SESSION,
		paneId: PANE,
		hostPid: p.hostPid,
		shellPid: p.shellPid,
		// What the registry proved about this pane when the binding was CREATED.
		boundIdentity: "boundIdentity" in overrides ? overrides.boundIdentity : processes(p),
		write: vi.fn((data: string) => void writes.push(data)),
		resize: vi.fn(),
		hostRole: vi.fn(() => currentRole),
		hostWriterAttached: vi.fn(() => true),
		claimHostWriter: vi.fn(async () => currentRole),
		writerPid: vi.fn(async () => process.pid),
		detach: vi.fn(),
	} as unknown as NativeTaskTerminal;
	return {
		terminal,
		writes,
		setRole(next: "writer" | "observer") {
			currentRole = next;
		},
	};
}

let programSeq = 0;
function program(stages: PaneInputStage[], overrides: Partial<PaneInputProgram> = {}): PaneInputProgram {
	programSeq += 1;
	return { deliveryId: `d-${programSeq}`, attempt: 1, incarnation: incarnationOf(A), stages, ...overrides };
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
	vi.mocked(inspectNativeTaskPane).mockResolvedValue(observed());
	vi.mocked(inspectNativePaneIdentity).mockReturnValue({ ok: true, identity: processes(A) });
	vi.mocked(resolvePaneOwner).mockResolvedValue({ kind: "local" });
});

afterEach(() => {
	vi.clearAllMocks();
});

// The encoding is asserted where it is observable: the bytes a delivery WRITES. Reaching
// into the table itself would prove the table, not what the shell receives.
// Windows records carry no start signature by design (ownership is a Job Object), and both
// the identity layer and the schema require one. Without this refusal a cleanly owned
// Windows pane reported pane-dead, or was rejected as the caller's invalid input.
describe("a pane whose ownership evidence this seam cannot express is refused loudly", () => {
	// EITHER signature missing is enough: with only the host checked, a record with a host
	// signature and an empty shell one would pin and fail later, inside checkWritable.
	it.each([
		["both signatures missing", { host: "", shell: "" }],
		["only the host signature missing", { host: "", shell: "shell-A" }],
		["only the shell signature missing", { host: "host-A", shell: "" }],
	])("refuses to pin when %s, as a backend failure", async (_name, signatures) => {
		vi.mocked(inspectNativeTaskPane).mockResolvedValue({
			kind: "observed",
			sessionId: SESSION,
			host: { pid: 4242, startSignature: signatures.host },
			shell: { pid: 4243, startSignature: signatures.shell },
			ownership: "owned",
		});

		const pin = await resolveNativePaneIncarnation(task(), PANE);
		expect(pin).toMatchObject({ ok: false, reason: "backend-failure" });
		if (pin.ok) return;
		expect(pin.detail).toContain(SESSION);
		// The detail states the FACT observed. The job-object explanation is win32's only.
		expect(pin.detail).toContain(
			process.platform === "win32" ? "ownership evidence is a job object" : "carries no process start signature",
		);
	});
});

describe("the PTY byte table covers the neutral set", () => {
	/** The bytes one program actually wrote to the bound pane. */
	async function written(stages: PaneInputStage[]): Promise<string> {
		const { terminal, writes } = fakeTerminal();
		vi.mocked(nativePaneTerminal).mockReturnValue(terminal);
		await deliverNativePaneInput(task(), program(stages));
		return writes.join("");
	}

	it("encodes every neutral key, with no two keys sharing bytes", async () => {
		const bytes = await Promise.all(PANE_INPUT_KEYS.map((key) => written([{ steps: [{ kind: "key", key }] }])));
		expect(bytes.every(Boolean)).toBe(true);
		expect(new Set(bytes).size).toBe(bytes.length);
	});

	it("encodes the arrows and Enter the way a shell line editor expects", async () => {
		expect(await written([{ steps: [{ kind: "key", key: "left" }] }])).toBe("\x1b[D");
		expect(await written([{ steps: [{ kind: "key", key: "right" }] }])).toBe("\x1b[C");
		expect(await written([{ steps: [{ kind: "key", key: "enter" }] }])).toBe("\r");
	});

	it("repeats a key's bytes and passes text through untouched", async () => {
		expect(await written([{ steps: [{ kind: "key", key: "left", count: 3 }] }])).toBe("\x1b[D\x1b[D\x1b[D");
		// "Enter" as TEXT is five characters, not the key.
		expect(await written([{ steps: [{ kind: "text", text: "Enter" }] }])).toBe("Enter");
	});
});

describe("native never claims a delivery it cannot prove", () => {
	it("writes the whole program but reports it unacknowledged, not delivered", async () => {
		const { terminal, writes } = fakeTerminal();
		vi.mocked(nativePaneTerminal).mockReturnValue(terminal);

		const outcome = await deliverNativePaneInput(task(), program(TEXT));

		expect(writes).toEqual(["hello"]);
		expect(outcome).toMatchObject({
			status: "indeterminate",
			possiblyAcceptedThrough: 1,
			reason: "unacknowledged",
			backend: "native",
		});
		expect(tmux.sendKeysGuarded).not.toHaveBeenCalled();
	});

	it("coalesces every step of a stage into ONE write call", async () => {
		const { terminal, writes } = fakeTerminal();
		vi.mocked(nativePaneTerminal).mockReturnValue(terminal);

		await deliverNativePaneInput(
			task(),
			program([{ steps: [{ kind: "text", text: "ab" }, { kind: "key", key: "left", count: 2 }] }]),
		);

		expect(terminal.write).toHaveBeenCalledTimes(1);
		expect(writes).toEqual(["ab\x1b[D\x1b[D"]);
	});

	it("keeps a submit program's Enter in its own write after the gap", async () => {
		const { terminal, writes } = fakeTerminal();
		vi.mocked(nativePaneTerminal).mockReturnValue(terminal);

		const outcome = await deliverNativePaneInput(task(), program(submitStages("deploy", 1)));

		expect(writes).toEqual(["deploy", "\r"]);
		expect(outcome).toMatchObject({ status: "indeterminate", possiblyAcceptedThrough: 2 });
	});

	it("never falls back to tmux when nothing native answers", async () => {
		vi.mocked(nativePaneTerminal).mockReturnValue(null);
		const outcome = await deliverNativePaneInput(task(), program(TEXT));

		expect(tmux.sendKeysGuarded).not.toHaveBeenCalled();
		expect(outcome.status).toBe("not-started");
	});
});

describe("the write target must BE the pinned incarnation", () => {
	/**
	 * The counterexample this guard exists for: the caller pinned successor B, the
	 * record already describes B, and a cached WRITABLE binding to predecessor A is
	 * still in the registry. Comparing the pin against the record alone would pass.
	 */
	it("refuses a program pinned to B while a stale binding to A survives, and writes nothing to A", async () => {
		const stale = fakeTerminal(A);
		vi.mocked(nativePaneTerminal).mockReturnValue(stale.terminal);
		vi.mocked(inspectNativePaneIdentity).mockReturnValue({ ok: true, identity: processes(B) });

		const outcome = await deliverNativePaneInput(task(), program(TEXT, { incarnation: incarnationOf(B) }));

		expect(stale.terminal.write).not.toHaveBeenCalled();
		expect(stale.writes).toEqual([]);
		expect(outcome).toMatchObject({
			status: "not-started",
			reason: "incarnation-changed",
			retryableAsNewDelivery: false,
		});
		if (outcome.status !== "not-started") return;
		expect(outcome.detail).toContain("stale binding");
	});

	it("refuses the same stale binding on the owner side too", async () => {
		const stale = fakeTerminal(A);
		vi.mocked(nativePaneTerminal).mockReturnValue(stale.terminal);
		vi.mocked(inspectNativePaneIdentity).mockReturnValue({ ok: true, identity: processes(B) });

		const outcome = await runNativePaneInputAsOwner(program(TEXT, { incarnation: incarnationOf(B) }));

		expect(stale.writes).toEqual([]);
		expect(outcome).toMatchObject({ status: "not-started", reason: "incarnation-changed" });
	});

	it("refuses a pin to A once the live pane is B", async () => {
		const { terminal, writes } = fakeTerminal(B);
		vi.mocked(nativePaneTerminal).mockReturnValue(terminal);
		vi.mocked(inspectNativePaneIdentity).mockReturnValue({ ok: true, identity: processes(B) });

		const outcome = await deliverNativePaneInput(task(), program(TEXT));
		expect(writes).toEqual([]);
		expect(outcome).toMatchObject({ status: "not-started", reason: "incarnation-changed" });
	});

	/**
	 * The case pids alone cannot catch, on the binding's FIRST pane-input use: the
	 * successor inherited BOTH numbers, so only what the binding captured when it was
	 * created tells it from its predecessor.
	 */
	it("refuses a binding created for A on its FIRST use after B inherited both pids", async () => {
		const recycled = { ...A, hostSig: "host-A2", shellSig: "shell-A2" };
		const stale = fakeTerminal(A); // bound when the pane was still A
		vi.mocked(nativePaneTerminal).mockReturnValue(stale.terminal);
		vi.mocked(inspectNativePaneIdentity).mockReturnValue({ ok: true, identity: processes(recycled) });

		const outcome = await deliverNativePaneInput(task(), program(TEXT, { incarnation: incarnationOf(recycled) }));

		expect(stale.terminal.write).not.toHaveBeenCalled();
		expect(stale.writes).toEqual([]);
		expect(outcome).toMatchObject({ status: "not-started", reason: "incarnation-changed" });
	});

	it("refuses the same first use on the owner side", async () => {
		const recycled = { ...A, hostSig: "host-A2", shellSig: "shell-A2" };
		const stale = fakeTerminal(A);
		vi.mocked(nativePaneTerminal).mockReturnValue(stale.terminal);
		vi.mocked(inspectNativePaneIdentity).mockReturnValue({ ok: true, identity: processes(recycled) });

		const outcome = await runNativePaneInputAsOwner(program(TEXT, { incarnation: incarnationOf(recycled) }));

		expect(stale.writes).toEqual([]);
		expect(outcome).toMatchObject({ status: "not-started", reason: "incarnation-changed" });
	});

	// No bind-time evidence means the binding cannot be proved to be this pane at all.
	it("refuses a binding that captured no identity when it was created", async () => {
		const unproven = fakeTerminal(A, "writer", { boundIdentity: null });
		vi.mocked(nativePaneTerminal).mockReturnValue(unproven.terminal);

		const outcome = await deliverNativePaneInput(task(), program(TEXT));
		expect(unproven.writes).toEqual([]);
		expect(outcome).toMatchObject({ status: "not-started", reason: "incarnation-changed" });
	});

	// Only a record that is GONE proves death. A record the app cannot read, or one a newer
	// side-by-side build wrote, proves nothing — reporting those as death would declare a
	// live writer-owned pane dead, which is the collapse this whole change exists to avoid.
	it.each([
		["absent", { kind: "absent" as const }, "pane-absent"],
		["missing", { kind: "missing" as const }, "pane-dead"],
		["unreadable-file", { kind: "unreadable-file" as const, message: "EACCES" }, "backend-failure"],
		["invalid-json", { kind: "invalid-json" as const }, "backend-failure"],
		["foreign-schema", { kind: "foreign-schema" as const, schemaVersion: 99 }, "backend-failure"],
		["invalid-fields", { kind: "invalid-fields" as const }, "backend-failure"],
	])("maps a $0 record to its own verdict, never guessing death", async (_name, problem, reason) => {
		const { terminal, writes } = fakeTerminal();
		vi.mocked(nativePaneTerminal).mockReturnValue(terminal);
		vi.mocked(inspectNativePaneIdentity).mockReturnValue({ ok: false, problem });

		const outcome = await deliverNativePaneInput(task(), program(TEXT));
		expect(writes).toEqual([]);
		expect(outcome).toMatchObject({ status: "not-started", reason });
	});
});

describe("everything provable before the first byte is not-started", () => {
	// Attaching a client can make this process the writer, so a missing binding is a
	// refusal rather than something to fix by connecting.
	it("refuses when this process holds no binding, instead of attaching one", async () => {
		vi.mocked(nativePaneTerminal).mockReturnValue(null);

		const outcome = await deliverNativePaneInput(task(), program(TEXT));
		expect(outcome).toMatchObject({ status: "not-started", reason: "read-only" });
		if (outcome.status !== "not-started") return;
		expect(outcome.detail).toContain("never attaches");
	});

	it("reports owner-unknown as retryable and writes nothing", async () => {
		const { terminal, writes } = fakeTerminal(A, "observer");
		vi.mocked(nativePaneTerminal).mockReturnValue(terminal);
		vi.mocked(resolvePaneOwner).mockResolvedValue({ kind: "unknown" });

		const outcome = await deliverNativePaneInput(task(), program(TEXT));
		expect(writes).toEqual([]);
		expect(outcome).toMatchObject({ status: "not-started", reason: "owner-unknown", retryableAsNewDelivery: true });
	});

	it("reports pane-dead when the host is gone", async () => {
		vi.mocked(nativePaneTerminal).mockReturnValue(fakeTerminal().terminal);
		vi.mocked(resolvePaneOwner).mockResolvedValue({ kind: "gone" });

		const outcome = await deliverNativePaneInput(task(), program(TEXT));
		expect(outcome).toMatchObject({ status: "not-started", reason: "pane-dead", retryableAsNewDelivery: false });
	});

	it("rejects a malformed or oversized program before admission, on both entry points", async () => {
		const { terminal, writes } = fakeTerminal();
		vi.mocked(nativePaneTerminal).mockReturnValue(terminal);

		await expect(runNativePaneInputAsOwner(program([{ steps: [] }]))).resolves.toMatchObject({
			status: "not-started",
			reason: "invalid-input",
		});
		const huge = program([{ steps: [{ kind: "text", text: "x".repeat(PANE_INPUT_LIMITS.maxStageBytes + 1) }] }]);
		await expect(runNativePaneInputAsOwner(huge)).resolves.toMatchObject({
			status: "not-started",
			reason: "invalid-input",
		});
		await expect(deliverNativePaneInput(task(), huge)).resolves.toMatchObject({
			status: "not-started",
			reason: "invalid-input",
		});
		expect(writes).toEqual([]);
	});
});

describe("pane input never claims or moves a writer lease", () => {
	// Hidden input must not hand the keyboard to whoever typed last; explicit Take
	// control owns lease changes.
	it("reports read-only for a vacant lease, with zero claim calls", async () => {
		const { terminal, writes } = fakeTerminal(A, "observer");
		vi.mocked(nativePaneTerminal).mockReturnValue(terminal);
		vi.mocked(resolvePaneOwner).mockResolvedValue({ kind: "vacant" });

		const outcome = await deliverNativePaneInput(task(), program(TEXT));

		expect(terminal.claimHostWriter).not.toHaveBeenCalled();
		expect(writes).toEqual([]);
		expect(outcome).toMatchObject({ status: "not-started", reason: "read-only", retryableAsNewDelivery: true });
	});

	it("makes zero claim calls in EVERY owner state", async () => {
		const states = [
			{ kind: "local" },
			{ kind: "vacant" },
			{ kind: "unknown" },
			{ kind: "gone" },
			{ kind: "peer", pid: 777, endpoint: "/tmp/777.sock" },
		] as const;
		for (const state of states) {
			const fake = fakeTerminal(A, "observer");
			vi.mocked(nativePaneTerminal).mockReturnValue(fake.terminal);
			vi.mocked(resolvePaneOwner).mockResolvedValue({ ...state } as never);
			vi.mocked(forwardToOwner).mockRejectedValue(new ForwardToOwnerError("no peer", "before-dispatch", 777));

			await deliverNativePaneInput(task(), program(TEXT));
			expect(fake.terminal.claimHostWriter, state.kind).not.toHaveBeenCalled();
		}
	});

	it("never claims on the owner side either", async () => {
		const { terminal, writes } = fakeTerminal(A, "observer");
		vi.mocked(nativePaneTerminal).mockReturnValue(terminal);

		const outcome = await runNativePaneInputAsOwner(program(TEXT));
		expect(terminal.claimHostWriter).not.toHaveBeenCalled();
		expect(writes).toEqual([]);
		expect(outcome).toMatchObject({ status: "not-started", reason: "read-only" });
	});
});

describe("a lease lost mid-program is never reported as nothing-happened", () => {
	it("turns a role change between stages into indeterminate with the honest bound", async () => {
		const fake = fakeTerminal();
		vi.mocked(fake.terminal.write).mockImplementation((data: string) => {
			fake.writes.push(data);
			fake.setRole("observer");
		});
		vi.mocked(nativePaneTerminal).mockReturnValue(fake.terminal);

		const outcome = await deliverNativePaneInput(task(), program(submitStages("deploy", 1)));

		expect(fake.writes).toEqual(["deploy"]);
		expect(outcome).toMatchObject({ status: "indeterminate", possiblyAcceptedThrough: 1, reason: "lease-lost" });
	});

	it("reports a throwing write as indeterminate, never as a byte boundary", async () => {
		const { terminal } = fakeTerminal();
		vi.mocked(terminal.write).mockImplementation(() => {
			throw new Error("socket closed");
		});
		vi.mocked(nativePaneTerminal).mockReturnValue(terminal);

		const outcome = await deliverNativePaneInput(task(), program(TEXT));
		expect(outcome).toMatchObject({ status: "indeterminate", possiblyAcceptedThrough: 1, reason: "backend-failure" });
	});
});

describe("the owner side is a dead end", () => {
	it("performs the program locally and never forwards or resolves an owner", async () => {
		const { terminal, writes } = fakeTerminal();
		vi.mocked(nativePaneTerminal).mockReturnValue(terminal);

		const outcome = await runNativePaneInputAsOwner(program(TEXT));

		expect(writes).toEqual(["hello"]);
		expect(forwardToOwner).not.toHaveBeenCalled();
		expect(resolvePaneOwner).not.toHaveBeenCalled();
		expect(outcome.status).toBe("indeterminate");
	});

	it("reports pane-dead when the owning process has no binding for the pane", async () => {
		vi.mocked(nativePaneTerminal).mockReturnValue(null);
		await expect(runNativePaneInputAsOwner(program(TEXT))).resolves.toMatchObject({
			status: "not-started",
			reason: "pane-dead",
		});
	});
});

describe("forwarding to a peer owner keeps the delivery whole", () => {
	const peer = { kind: "peer", pid: 777, endpoint: "/tmp/777.sock" } as const;

	/** A well-formed indeterminate reply from the owner. */
	function ownerReply(sent: PaneInputProgram, over: Record<string, unknown> = {}): Record<string, unknown> {
		return {
			deliveryId: sent.deliveryId,
			backend: "native",
			paneId: PANE,
			executor: "peer-process:abcd1234",
			status: "indeterminate",
			possiblyAcceptedThrough: 1,
			reason: "unacknowledged",
			...over,
		};
	}

	/** A well-formed not-started reply — a DIFFERENT field set, not a spread of the above. */
	function ownerNotStarted(sent: PaneInputProgram, over: Record<string, unknown> = {}): Record<string, unknown> {
		return {
			deliveryId: sent.deliveryId,
			backend: "native",
			paneId: PANE,
			executor: "peer-process:abcd1234",
			status: "not-started",
			reason: "read-only",
			retryableAsNewDelivery: true,
			...over,
		};
	}

	beforeEach(() => {
		vi.mocked(nativePaneTerminal).mockReturnValue(fakeTerminal().terminal);
		vi.mocked(resolvePaneOwner).mockResolvedValue({ ...peer });
	});

	it("forwards the whole program once and never also writes locally", async () => {
		const fake = fakeTerminal();
		vi.mocked(nativePaneTerminal).mockReturnValue(fake.terminal);
		const sent = program(TEXT);
		vi.mocked(forwardToOwner).mockResolvedValue(ownerReply(sent));

		const outcome = await deliverNativePaneInput(task(), sent);

		expect(fake.writes).toEqual([]);
		expect(forwardToOwner).toHaveBeenCalledTimes(1);
		expect(vi.mocked(forwardToOwner).mock.calls[0]?.[2]).toMatchObject({ deliveryId: sent.deliveryId });
		expect(outcome).toMatchObject({ status: "indeterminate", reason: "unacknowledged" });
	});

	it("passes the owner's own verdict straight through when it is well-formed", async () => {
		const sent = program(TEXT);
		vi.mocked(forwardToOwner).mockResolvedValue(ownerNotStarted(sent));
		await expect(deliverNativePaneInput(task(), sent)).resolves.toMatchObject({
			status: "not-started",
			reason: "read-only",
			retryableAsNewDelivery: true,
		});
	});

	// A reply is evidence only if it describes THIS delivery. Anything else is
	// uncertainty: the request went out regardless.
	it("rejects a reply for another delivery, pane, or backend", async () => {
		for (const wrong of [{ deliveryId: "someone-else" }, { paneId: "pane-9" }, { backend: "tmux" }]) {
			const sent = program(TEXT);
			vi.mocked(forwardToOwner).mockResolvedValue(ownerReply(sent, wrong));
			const outcome = await deliverNativePaneInput(task(), sent);
			expect(outcome, JSON.stringify(wrong)).toMatchObject({ status: "indeterminate", reason: "owner-unreachable" });
		}
	});

	it("rejects an owner that claims a delivered OR a partial native program", async () => {
		for (const claim of [
			{ status: "delivered", acceptedThrough: 1 },
			{ status: "partial", acceptedThrough: 1, uncertainStep: null, reason: "pane-dead" },
		]) {
			const sent = program(TEXT);
			vi.mocked(forwardToOwner).mockResolvedValue(ownerReply(sent, claim));
			const outcome = await deliverNativePaneInput(task(), sent);
			expect(outcome, claim.status).toMatchObject({ status: "indeterminate", reason: "owner-unreachable" });
			if (outcome.status !== "indeterminate") return;
			expect(outcome.detail).toContain("no host can acknowledge");
		}
	});

	it("rejects a reason that is not legal on the status it came with", async () => {
		const sent = program(TEXT);
		// `unacknowledged` exists, but only ever as uncertainty — never as nothing-started.
		vi.mocked(forwardToOwner).mockResolvedValue(
			ownerNotStarted(sent, { reason: "unacknowledged", retryableAsNewDelivery: false }),
		);
		const outcome = await deliverNativePaneInput(task(), sent);
		expect(outcome).toMatchObject({ status: "indeterminate", reason: "owner-unreachable" });
		if (outcome.status !== "indeterminate") return;
		expect(outcome.detail).toContain("not a legal not-started reason");
	});

	it("rejects a retry verdict that contradicts its own reason", async () => {
		const sent = program(TEXT);
		vi.mocked(forwardToOwner).mockResolvedValue(
			ownerNotStarted(sent, { reason: "pane-dead", retryableAsNewDelivery: true }),
		);
		await expect(deliverNativePaneInput(task(), sent)).resolves.toMatchObject({
			status: "indeterminate",
			reason: "owner-unreachable",
		});
	});

	it("rejects a reply carrying a field its verdict does not have, or no executor", async () => {
		const sent = program(TEXT);
		vi.mocked(forwardToOwner).mockResolvedValue(ownerReply(sent, { acceptedThrough: 1 }));
		const smuggled = await deliverNativePaneInput(task(), sent);
		expect(smuggled).toMatchObject({ reason: "owner-unreachable" });
		// Name the field, so a widened allowlist cannot pass by landing on the same verdict.
		expect(String("detail" in smuggled ? smuggled.detail : "")).toContain("unexpected field acceptedThrough");

		const other = program(TEXT);
		const noExecutor = { ...ownerReply(other) };
		delete noExecutor.executor;
		vi.mocked(forwardToOwner).mockResolvedValue(noExecutor);
		await expect(deliverNativePaneInput(task(), other)).resolves.toMatchObject({ reason: "owner-unreachable" });
	});

	it("rejects an unknown status, an unknown reason, and a missing retry verdict", async () => {
		for (const wrong of [
			{ status: "made-up" },
			{ status: "indeterminate", reason: "nonsense" },
			{ status: "indeterminate", reason: "read-only" },
		]) {
			const sent = program(TEXT);
			vi.mocked(forwardToOwner).mockResolvedValue(ownerReply(sent, wrong));
			const outcome = await deliverNativePaneInput(task(), sent);
			expect(outcome, JSON.stringify(wrong)).toMatchObject({ status: "indeterminate", reason: "owner-unreachable" });
		}
	});

	it("rejects counts outside the program's own step range", async () => {
		for (const wrong of [{ possiblyAcceptedThrough: 99 }, { possiblyAcceptedThrough: -1 }]) {
			const sent = program(TEXT);
			vi.mocked(forwardToOwner).mockResolvedValue(ownerReply(sent, wrong));
			const outcome = await deliverNativePaneInput(task(), sent);
			expect(outcome, JSON.stringify(wrong)).toMatchObject({ status: "indeterminate", reason: "owner-unreachable" });
		}
	});

	it("maps a failure proven BEFORE dispatch to not-started, so a new id may carry it", async () => {
		const fake = fakeTerminal();
		vi.mocked(nativePaneTerminal).mockReturnValue(fake.terminal);
		vi.mocked(forwardToOwner).mockRejectedValue(
			new ForwardToOwnerError("connect refused", "before-dispatch", peer.pid),
		);

		const outcome = await deliverNativePaneInput(task(), program(TEXT));
		expect(fake.writes).toEqual([]);
		expect(outcome).toMatchObject({
			status: "not-started",
			reason: "owner-unreachable",
			retryableAsNewDelivery: true,
		});
	});

	it("maps a failure after dispatch to indeterminate, never to a resendable verdict", async () => {
		vi.mocked(forwardToOwner).mockRejectedValue(
			new ForwardToOwnerError("owner did not answer in time", "possibly-dispatched", peer.pid),
		);
		await expect(deliverNativePaneInput(task(), program(submitStages("hi", 1)))).resolves.toMatchObject({
			status: "indeterminate",
			possiblyAcceptedThrough: 2,
			reason: "owner-unreachable",
		});
	});

	it("treats an untyped forward failure as indeterminate, the conservative side", async () => {
		vi.mocked(forwardToOwner).mockRejectedValue(new Error("something else broke"));
		await expect(deliverNativePaneInput(task(), program(TEXT))).resolves.toMatchObject({
			status: "indeterminate",
			reason: "owner-unreachable",
		});
	});
});

describe("pinning observes, and keeps every state distinct", () => {
	it("pins what the observation proves, with no reconciliation", async () => {
		await expect(resolveNativePaneIncarnation(task(), PANE)).resolves.toEqual({
			ok: true,
			incarnation: incarnationOf(A),
		});
	});

	it("reports pane-absent for a coordinator that has no such pane, and for no coordinator", async () => {
		vi.mocked(inspectNativeTaskPane).mockResolvedValue({ kind: "pane-absent" });
		await expect(resolveNativePaneIncarnation(task(), PANE)).resolves.toMatchObject({
			ok: false,
			reason: "pane-absent",
		});

		vi.mocked(inspectNativeTaskPane).mockResolvedValue({ kind: "coordinator-absent" });
		await expect(resolveNativePaneIncarnation(task(), PANE)).resolves.toMatchObject({
			ok: false,
			reason: "pane-absent",
		});
	});

	// Proven dead: the session directory outlived its record, or the host pid is gone.
	it("reports pane-dead only when death is proven", async () => {
		vi.mocked(inspectNativeTaskPane).mockResolvedValue({
			kind: "session-problem",
			sessionId: SESSION,
			problem: { kind: "missing" },
		});
		await expect(resolveNativePaneIncarnation(task(), PANE)).resolves.toMatchObject({
			ok: false,
			reason: "pane-dead",
		});

		vi.mocked(inspectNativeTaskPane).mockResolvedValue(observed(A, "dead"));
		await expect(resolveNativePaneIncarnation(task(), PANE)).resolves.toMatchObject({
			ok: false,
			reason: "pane-dead",
		});
	});

	// Cannot prove state: never absent, never dead.
	it("reports backend-failure for corrupt, foreign, unreadable and undecidable reads", async () => {
		const problems = [
			{ kind: "invalid-json" as const },
			{ kind: "foreign-schema" as const, schemaVersion: 99 },
			{ kind: "unreadable-file" as const, message: "EIO" },
			{ kind: "invalid-fields" as const },
		];
		for (const problem of problems) {
			vi.mocked(inspectNativeTaskPane).mockResolvedValue({ kind: "session-problem", sessionId: SESSION, problem });
			await expect(resolveNativePaneIncarnation(task(), PANE), problem.kind).resolves.toMatchObject({
				ok: false,
				reason: "backend-failure",
			});
		}

		vi.mocked(inspectNativeTaskPane).mockResolvedValue({ kind: "coordinator-unreadable", detail: "misbound" });
		await expect(resolveNativePaneIncarnation(task(), PANE)).resolves.toMatchObject({
			ok: false,
			reason: "backend-failure",
		});
	});

	// A record copied from another session describes processes this pane does not own.
	it("refuses a pane whose record names a different session", async () => {
		vi.mocked(inspectNativeTaskPane).mockResolvedValue({
			kind: "foreign-record",
			sessionId: SESSION,
			recordSessionId: "dev3-task-somebody-else-pane-1",
		});
		const pin = await resolveNativePaneIncarnation(task(), PANE);
		expect(pin).toMatchObject({ ok: false, reason: "backend-failure" });
		if (pin.ok) return;
		expect(pin.detail).toContain("somebody-else");
	});

	// A dead SHELL is as fatal as a dead host, and ownership classifies both.
	it("reports pane-dead when either process is gone", async () => {
		vi.mocked(inspectNativeTaskPane).mockResolvedValue(observed(A, "dead"));
		await expect(resolveNativePaneIncarnation(task(), PANE)).resolves.toMatchObject({
			ok: false,
			reason: "pane-dead",
		});
	});

	// A live pid whose start signature no longer matches is a REUSED pid, not this pane.
	it("reports backend-failure for a reused pid, never a live pane", async () => {
		vi.mocked(inspectNativeTaskPane).mockResolvedValue(observed(A, "reused"));
		const pin = await resolveNativePaneIncarnation(task(), PANE);
		expect(pin).toMatchObject({ ok: false, reason: "backend-failure" });
		if (pin.ok) return;
		expect(pin.detail).toContain("no longer owns");
	});

	// The pin is a snapshot; the write target is checked again, so a pane that dies or is
	// replaced AFTER pinning cannot be written to.
	it("refuses a pin whose pane was replaced after it was taken", async () => {
		const pin = await resolveNativePaneIncarnation(task(), PANE);
		expect(pin.ok).toBe(true);
		if (!pin.ok) return;

		const successor = fakeTerminal(B);
		vi.mocked(nativePaneTerminal).mockReturnValue(successor.terminal);
		vi.mocked(inspectNativePaneIdentity).mockReturnValue({ ok: true, identity: processes(B) });

		const outcome = await deliverNativePaneInput(task(), program(TEXT, { incarnation: pin.incarnation }));
		expect(successor.writes).toEqual([]);
		expect(outcome).toMatchObject({ status: "not-started", reason: "incarnation-changed" });
	});

	it("refuses a pin whose session record disappeared after it was taken", async () => {
		const pin = await resolveNativePaneIncarnation(task(), PANE);
		if (!pin.ok) return;

		const { terminal, writes } = fakeTerminal(A);
		vi.mocked(nativePaneTerminal).mockReturnValue(terminal);
		vi.mocked(inspectNativePaneIdentity).mockReturnValue({ ok: false, problem: { kind: "absent" } });

		const outcome = await deliverNativePaneInput(task(), program(TEXT, { incarnation: pin.incarnation }));
		expect(writes).toEqual([]);
		expect(outcome).toMatchObject({ status: "not-started", reason: "pane-absent" });
	});
});
