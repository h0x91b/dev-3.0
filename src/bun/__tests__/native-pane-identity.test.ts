import { afterEach, describe, expect, it, vi } from "vitest";

// The identity layer is where a bare pid must be refused. Without these cases a mutation
// that trusts record.host.pid alone would make Windows appear to work — comparing recycled
// pids — with every other test still green.
vi.mock("../native-terminal-registry/record", () => ({ inspectRecordFile: vi.fn() }));

import { inspectRecordFile } from "../native-terminal-registry/record";
import { inspectNativePaneIdentity, nativeBoundIdentityOf } from "../native-pane-identity";

const SESSION = "dev3-task-ef0ea197-pane-1";

function record(over: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		sessionId: SESSION,
		host: { pid: 10, startSignature: "host-sig" },
		shell: { pid: 11, startSignature: "shell-sig" },
		...over,
	};
}

afterEach(() => vi.clearAllMocks());

describe("a record proves identity only with BOTH start signatures", () => {
	it("accepts a record that names both processes and their signatures", () => {
		expect(nativeBoundIdentityOf(record())).toEqual({
			sessionId: SESSION,
			host: { pid: 10, startSignature: "host-sig" },
			shell: { pid: 11, startSignature: "shell-sig" },
		});
	});

	it.each([
		["an empty host signature", { host: { pid: 10, startSignature: "" } }],
		["an empty shell signature", { shell: { pid: 11, startSignature: "" } }],
		["a missing host signature", { host: { pid: 10 } }],
		["a non-integer pid", { host: { pid: 1.5, startSignature: "host-sig" } }],
		["no session id", { sessionId: "" }],
	])("refuses %s, because a pid alone is handed to a successor", (_name, over) => {
		expect(nativeBoundIdentityOf(record(over))).toBeNull();
	});
});

describe("the reader reports WHY a record could not be used", () => {
	it("passes the record problem through instead of collapsing it to nothing", () => {
		vi.mocked(inspectRecordFile).mockReturnValue({ ok: false, problem: { kind: "unreadable-file", message: "EACCES" } });
		expect(inspectNativePaneIdentity(SESSION)).toEqual({
			ok: false,
			problem: { kind: "unreadable-file", message: "EACCES" },
		});
	});

	// An accepted record that cannot prove both processes is unusable, NOT proof of death.
	it("reports an accepted-but-unprovable record as invalid fields", () => {
		vi.mocked(inspectRecordFile).mockReturnValue({
			ok: true,
			record: record({ shell: { pid: 11, startSignature: "" } }) as never,
		});
		expect(inspectNativePaneIdentity(SESSION)).toEqual({ ok: false, problem: { kind: "invalid-fields" } });
	});

	it("returns the identity when the record is usable", () => {
		vi.mocked(inspectRecordFile).mockReturnValue({ ok: true, record: record() as never });
		const read = inspectNativePaneIdentity(SESSION);
		expect(read.ok && read.identity.shell.startSignature).toBe("shell-sig");
	});
});
