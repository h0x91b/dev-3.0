import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../logger", () => ({
	createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import type { CliResponse, Project, Task } from "../../shared/types";
import { SENDER_INBOX_BUSY_ERROR, UNKNOWN_EXTERNAL_SENDER_ERROR } from "../../shared/external-senders";
import { findTool, runTool, type ToolContext } from "../mcp/tools";
import type { McpTokenRecord } from "../mcp/token-store";

const PROJECT = { id: "aaaaaaaa-0000-0000-0000-000000000001", name: "A", path: "/a" } as Project;
const TASK = { id: "aaaaaaaa-task-0000-0000-000000000001", seq: 7, projectId: PROJECT.id, status: "in-progress", title: "t" } as Task;
const TOKEN: McpTokenRecord = {
	id: "t", sha256: "0".repeat(64), sender: "openclaw:home:main", scopes: ["read", "send"], projects: [PROJECT.id],
	autoApprove: false, label: null, createdAt: "", expiresAt: null, revokedAt: null,
};

let calls: Array<{ method: string; params: Record<string, unknown> }>;
let reply: (method: string) => CliResponse;

function ctx(signal?: AbortSignal): ToolContext {
	return {
		token: TOKEN, senderLabel: "Main", signal,
		call: async (method, params) => {
			calls.push({ method, params });
			if (method === "projects.list") return { id: "x", ok: true, data: [PROJECT] };
			if (method === "tasks.list") return { id: "x", ok: true, data: [TASK] };
			return reply(method);
		},
	};
}

beforeEach(() => {
	calls = [];
	reply = () => ({ id: "x", ok: true, data: {} });
});

const run = (name: string, args: Record<string, unknown>, c = ctx()) => runTool(findTool(name)!, args, c);
const ofMethod = (m: string) => calls.filter((c) => c.method === m);

describe("message_send", () => {
	it("speaks as the token's sender through message.sendAsSender only", async () => {
		reply = () => ({ id: "x", ok: true, data: { status: "queued", messageId: "m1" } });
		const out = await run("message_send", { task: "seq:7", subject: "PR merged", text: "hello" });
		expect(out).toEqual({ exitCode: 0, json: { status: "queued", messageId: "m1" } });
		expect(ofMethod("message.sendAsSender")).toEqual([{ method: "message.sendAsSender", params: {
			taskId: TASK.id, projectId: PROJECT.id, text: "hello", subject: "PR merged", asSender: "openclaw:home:main",
		} }]);
		expect(ofMethod("message.send")).toEqual([]);
	});

	it("reports an unconfirmed delivery as exit 11, not a failure", async () => {
		reply = () => ({ id: "x", ok: true, data: { status: "unconfirmed", messageId: "m1" } });
		const out = await run("message_send", { task: "seq:7", subject: "s", text: "t" });
		expect(out.exitCode).toBe(11);
		expect(findTool("message_send")!.successCodes).toContain(11);
	});

	it("prints the not-delivered verdict with the CLI's exit code", async () => {
		reply = () => ({ id: "x", ok: false, error: `${UNKNOWN_EXTERNAL_SENDER_ERROR} "openclaw:home:main".` });
		const out = await run("message_send", { task: "seq:7", subject: "s", text: "t" });
		expect(out.exitCode).toBe(39);
		expect(out.json).toMatchObject({ status: "not-delivered", messageId: null });
	});

	it("refuses an empty subject with exit 17 before anything is sent", async () => {
		const out = await run("message_send", { task: "seq:7", subject: "   ", text: "t" });
		expect(out.exitCode).toBe(17);
		expect(calls).toEqual([]);
	});
});

describe("inbox_wait / inbox_ack", () => {
	it("reads the token sender's inbox, passes the disconnect signal, and drops spill paths", async () => {
		reply = () => ({ id: "x", ok: true, data: { items: [{ id: "i", body: "b", spillPath: "/secret/path" }], cursor: "c", more: false } });
		const signal = new AbortController().signal;
		const out = await run("inbox_wait", { clientId: "gw", waitMs: 25000 }, ctx(signal));
		expect(ofMethod("sender.wait")[0].params).toMatchObject({ senderId: "openclaw:home:main", clientId: "gw", timeoutMs: 25000 });
		expect(out.json).toEqual({ items: [{ id: "i", body: "b" }], cursor: "c", more: false });
		expect(findTool("inbox_wait")!.parked).toBe(true);
	});

	it("maps a busy lease to exit 40", async () => {
		reply = () => ({ id: "x", ok: false, error: `${SENDER_INBOX_BUSY_ERROR}: held by another client` });
		expect((await run("inbox_wait", { clientId: "gw" })).exitCode).toBe(40);
	});

	it("never accepts takeOver or a sender id from the caller", async () => {
		for (const extra of [{ takeOver: true }, { senderId: "someone:else" }]) {
			expect((await run("inbox_wait", { clientId: "gw", ...extra })).exitCode).toBe(3);
		}
		expect(calls).toEqual([]);
	});

	it("acks as the token's sender", async () => {
		reply = () => ({ id: "x", ok: true, data: { senderId: "x", acked: ["i"], unknown: [] } });
		const out = await run("inbox_ack", { clientId: "gw", ids: ["i"] });
		expect(out.json).toEqual({ acked: ["i"], unknown: [] });
		expect(ofMethod("sender.ack")[0].params.senderId).toBe("openclaw:home:main");
	});
});
